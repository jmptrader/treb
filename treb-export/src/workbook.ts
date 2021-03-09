

import * as ElementTree from 'elementtree';
import { Element, ElementTree as Tree } from 'elementtree';
import { Sheet } from './sheet';
import { SharedStrings } from './shared-strings';
import { StyleCache } from './style';
import { Theme } from './theme';

import * as JSZip from 'jszip';
import { Drawing } from './drawing/drawing';
import { Chart } from './drawing/chart';
import { IArea, Area } from 'treb-base-types/src';

const XMLTypeMap = {
  'sheet':          'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  'theme':          'application/vnd.openxmlformats-officedocument.theme+xml',
  'drawing':        'application/vnd.openxmlformats-officedocument.drawing+xml',
  'chart':          'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  'themeOverride':  'application/vnd.openxmlformats-officedocument.themeOverride+xml',
  'ctrlProp':       'application/vnd.ms-excel.controlproperties+xml',
  'style':          'application/vnd.ms-office.chartstyle+xml',
  'colors':         'application/vnd.ms-office.chartcolorstyle+xml',
};


interface Relationship {
  id?: string;
  type?: string;
  target?: string;
}

export class Workbook {

  public style_cache = new StyleCache(); // public temp
  public theme = new Theme();

  private zip?: JSZip;
  private shared_strings = new SharedStrings();
  // private sheets: {[index: string]: Sheet} = {};
  private sheets: Sheet[] = [];

  private dom?: Tree;
  private rels: {[index: string]: Relationship} = {};

  private rels_dom?: Tree;

  // public GetSheet(sheet: string|number) {
  public GetSheet(sheet: number) {
    // if (typeof sheet === 'string') return this.sheets[name];
    // else return this.sheets[Object.keys(this.sheets)[0]];
    return this.sheets[sheet];
  }

  public Count() {
    return this.sheets.length;
  }

  public RenameSheet(index: number, name: string) {
    if (!this.dom) throw new Error('missing dom');

    // local: does this matter? might as well keep it consistent
    this.sheets[index].options.name = name;

    // rename in workbook
    const sheet = this.dom.find(`./sheets/sheet/[@sheetId="${index + 1}"]`);
    if (sheet) {
      sheet.set('name', name);
    }
    else {
      console.warn('rename: missing sheet', index);
    }

  }

  public async ReadStyles() {
    if (!this.zip) throw new Error('missing zip');
    const data = await this.zip.file('xl/styles.xml')?.async('text') as string;
    this.style_cache.Init(data, this.theme);
  }

  public async ReadTheme() {
    if (!this.zip) throw new Error('missing zip');
    const file = this.zip.file('xl/theme/theme1.xml');
    if (file) {
      const data = await file.async('text');
      this.theme.Init(data);
    }
  }

  /**
   * break out strings table
   */
  public async ReadStringsTable(){

    if (!this.zip) throw new Error('missing zip');

    // simple unformatted strings have the structure <si><t>...</t></si>.
    // Formatted strings have the structure <si><r><rPr/><t>...</t></r></si>
    // with (potentially) multiple <r/> elements and formatting data in
    // the <rPr/> section inside each <r/>.

    // NOTE that there's a (relatively slim) possibility there is no
    // strings table -- you need a spreadsheet that has no strings in
    // it, and never had strings in it.

    // not sure what effect this will have on other functions, since
    // theoretically it should never be needed

    const shared_strings = this.zip.file('xl/sharedStrings.xml');
    if (!shared_strings) { return; }

    const data = await shared_strings.async('text');

    // FOR NOW, let's just ignore complex strings.  we'll track
    // simple strings as before (but now with correct indexes).
    // FIXME.

    // NOTE: there are overlaps, which renders this structure slightly broken.
    // I'll explain: we have two shared strings with the same text. the SS 
    // class is a map of text -> index, for historical reasons. if there's 
    // duplicate data, it's overwritten and the lookups fail.

    // solution: use a forward table. we should be doing that anyway. make
    // it optional, so we don't break any backcompat.

    this.shared_strings.dom = ElementTree.parse(data);
    this.shared_strings.map = {};
    this.shared_strings.len = 0;

    const reverse_map: string[] = [];

    this.shared_strings.dom.findall('./si').forEach((elt, idx) => {
      const children = elt.getchildren();
      if (children && children.length){
        const child = children[0];

        // simple string looks like
        //
        // <si>
        //   <t>text here!</t>
        // </si>

        if (child.tag === 't' && (typeof child.text === 'string')){
          const text = child.text.toString();
          this.shared_strings.map[text] = idx;
          reverse_map[idx] = text;
        }
        else if (child.tag === 'r') {

          // complex string looks like
          //
          // <si>
          //   <r>
          //     <rPr>(...style data...)</rPr>
          //     <t>text part</t>
          //   </r>
          // </si>
          //
          // where there can be multiple r tags with different styling.
          // since we don't support that atm, let's drop style and just
          // collect text.

          const text_parts: string[] = [];

          for (const composite of children) {
            if (composite.tag === 'r') {
              const composite_children = composite.getchildren();
              if (composite_children && composite_children[1] && composite_children[1].tag === 't') {
                text_parts.push(composite_children[1].text?.toString() || '');
              }
            }
          }

          const text = text_parts.join('') || '';
          this.shared_strings.map[text] = idx;
          reverse_map[idx] = text;

        }
        else {
          console.info('bad shared string @', idx, elt);
        }

        // console.info(idx, child);

      }
      else {
        console.info('no children?', elt);
      }
      this.shared_strings.len++;
    });

    if (reverse_map.length) {
      this.shared_strings.reverse_map = reverse_map;
    }

  }

  /**
   * read all sheets (async)
   */
  public async GetWorksheets(preparse = false, read_rels = false){
    if (!this.zip) throw new Error('missing zip');

    for (const sheet of this.sheets) {
      if (sheet) {
        const rid = sheet.options.rid;
        if (rid) {
          sheet.path = `xl/${this.rels[rid].target}`;
          sheet.rels_path = sheet.path.replace('worksheets', 'worksheets/_rels') + '.rels';
          const data = await this.zip.file(sheet.path)?.async('text');
          sheet.xml = data;
          if (preparse) sheet.Parse();

          if (read_rels) {
            sheet.rels_xml = await this.zip.file(sheet.rels_path)?.async('text');
            if (preparse) sheet.ReadRels();
          }

        }
      }
    }

  }

  public async UpdateFileInfo(options: {
    creator?: string;
    modified_by?: string;
    created?: Date;
    modified?: Date;
  }) {

    if (!this.zip) { return; }

    const core = await this.zip.file('docProps/core.xml')?.async('text') as string;
    const core_dom = ElementTree.parse(core);

    /*
      <dc:creator>TREB</dc:creator>
      <cp:lastModifiedBy>TREB</cp:lastModifiedBy>
      <dcterms:created xsi:type="dcterms:W3CDTF">2019-01-31T16:48:03Z</dcterms:created>
      <dcterms:modified xsi:type="dcterms:W3CDTF">2019-01-31T16:48:28Z</dcterms:modified>
    */

    let node: ElementTree.Element|null;

    if (options.creator) {
      node = core_dom.getroot().find('./dc:creator');
      if (node) { node.text = options.creator; }
    }

    if (options.modified_by) {
      node = core_dom.getroot().find('./cp:lastModifiedBy');
      if (node) { node.text = options.modified_by; }
    }

    if (options.created) {
      node = core_dom.getroot().find('./dcterms:created');
      if (node) { node.text = options.created.toISOString(); }
    }

    if (options.modified) {
      node = core_dom.getroot().find('./dcterms:modified');
      if (node) { node.text = options.modified.toISOString(); }
    }

    await this.zip.file('docProps/core.xml', core_dom.write({ xml_declaration: true }));

  }

  /**
   * finalize: rewrite xml, save in zip file.
   */
  public async Finalize(opts: any = {}){

    if (!this.zip) throw new Error('missing zip');
    if (!this.dom) throw new Error('missing dom');
    if (!this.rels_dom) throw new Error('missing rels_dom');

    // it seems like we already have this in overrides, not sure why

    if (this.shared_strings.dom) {
      const xml = this.shared_strings.dom.write({xml_declaration: true});
      await this.zip.file( 'xl/sharedStrings.xml', xml);
    }

    if (this.style_cache.modified && this.style_cache.dom) {
      const xml = this.style_cache.dom.write({xml_declaration: true});
      await this.zip.file( 'xl/styles.xml', xml);
    }

    // active tab

    const workbook_view = this.dom.find('./bookViews/workbookView');
    if (workbook_view) {
      let selected_tab = 0;
      for (let i = 0; i < this.sheets.length; i++) {
        if (this.sheets[i].tab_selected) {
          selected_tab = i;
          break;
        }
      }
      workbook_view.attrib.activeTab = selected_tab.toString();
    }

    await this.zip.file( 'xl/_rels/workbook.xml.rels', this.rels_dom.write({xml_declaration: true}));
    await this.zip.file( 'xl/workbook.xml', this.dom.write({xml_declaration: true}));

    if (opts.flushCalcChain || opts.flush){
      try {
        this.zip.remove('xl/calcChain.xml'); // what if it doesn't exist?
      }
      catch (e){
        console.warn(e);
      }
    }

    const time = new Date();
    await this.UpdateFileInfo({
      created: time,
      modified: time,
      creator: 'TREB',
      modified_by: 'TREB',
    });

    const content_types_path = '[Content_Types].xml';
    const content_types_data = await this.zip.file(content_types_path)?.async('text') as string;
    const content_types_dom = ElementTree.parse(content_types_data);

    // do sheets first, get them in [content_types] in order, then we will add drawing bits

    let index = 0;
    for (const sheet of this.sheets) {
      if (sheet.dom && sheet.path){
        sheet.Finalize();
        const xml = sheet.dom.write({xml_declaration: true});
        await this.zip.file(sheet.path, xml);

        if (sheet.rels_dom && sheet.rels_path) {
          const rels = sheet.rels_dom.write({xml_declaration: true});
          await this.zip.file(sheet.rels_path, rels);
        }

        /*
        if (sheet.drawing_rels && sheet.rels_path) {
          await this.zip.file(sheet.rels_path, Drawing.SheetRels(sheet.drawing_rels));
        }
        */

        if (index++) {
          content_types_dom.getroot().append(Element('Override', {
              PartName: '/' + sheet.path,
              ContentType: XMLTypeMap.sheet,
          }));
        }

      }
    }

    for (const sheet of this.sheets) {
      for (const drawing of sheet.drawings) {

        const drawing_path = `xl/drawings/drawing${drawing.index}.xml`;
        const drawing_rels_path = `xl/drawings/_rels/drawing${drawing.index}.xml.rels`;
        content_types_dom.getroot().append(Element('Override', { PartName: '/' + drawing_path, ContentType: XMLTypeMap.drawing }));
        await this.zip.file(drawing_path, drawing.GetDrawingXML());
        await this.zip.file(drawing_rels_path, drawing.GetDrawingRels());

        for (const anchored_chart of drawing.charts) {

          const chart = anchored_chart.chart;

          const chart_path =  `xl/charts/chart${chart.index}.xml`;
          const chart_rels_path =  `xl/charts/_rels/chart${chart.index}.xml.rels`;
          content_types_dom.getroot().append(Element('Override', { PartName: '/' + chart_path, ContentType: XMLTypeMap.chart }));
          await this.zip.file(chart_path, chart.GetChartXML());
          await this.zip.file(chart_rels_path, chart.GetChartRels());

          /*
          if (drawing.indexes.colors) {
            const colors_path = `xl/charts/colors${drawing.indexes.colors}.xml`;
            content_types_dom.getroot().append(Element('Override', { PartName: '/' + colors_path, ContentType: XMLTypeMap.colors }));
            await this.zip.file(colors_path, drawing.GetColorsXML());
          }

          if (drawing.indexes.style) {
            const style_path =  `xl/charts/style${drawing.indexes.style}.xml`;
            content_types_dom.getroot().append(Element('Override', { PartName: '/' + style_path, ContentType: XMLTypeMap.style }));
            await this.zip.file(style_path, drawing.GetStyleXML());
          }
          */

        }

      }
    }

    await this.zip.file(content_types_path, content_types_dom.write({xml_declaration: true}));

  }

  public GetNamedRanges(): {[index: string]: string} {
    if (!this.dom) throw new Error('missing dom');
    const results: {[index: string]: string} = {};

    const names = this.dom.find('./definedNames');
    if (names) {
      const children = names.getchildren();
      for (const child of children) {
        if (child.tag === 'definedName') {
          const name = child.attrib.name;
          const reference = child.text;

          if (name && reference) {
            results[name] = reference.toString();
          }
        }
      }
    }

    return results;
  }

  public AddNamedRanges(named_ranges: {[index: string]: IArea} = {}, name_map: string[] = []): void {
    if (!this.dom) throw new Error('missing dom');

    // this comes from parser. I'm inlining it because we don't include
    // parser in this worker (?)

    const QuotedSheetNameRegex = /[\s-+=<>!()]/;

    let names = this.dom.find('./definedNames');
    if (!names) {
      let found = false;
      names = Element('definedNames')
      const elements = this.dom.getroot().getchildren();
      for (let i = 0; i < elements.length; i++) {
        if (elements[i].tag === 'sheets') {
          this.dom.getroot().insert(i + 1, names);
          found = true;
          break;
        }
      }
      if (!found) {
        console.warn('insert point for definedNames not found');
      }
    }

    for (const name of Object.keys(named_ranges)) {
      const base = named_ranges[name];
      base.start.absolute_column = 
        base.start.absolute_row = 
        base.end.absolute_column =
        base.end.absolute_row = true;

      const area = new Area(base.start, base.end);

      if (typeof area.start.sheet_id !== 'undefined') {
        let sheet_name = name_map[area.start.sheet_id];
        if (QuotedSheetNameRegex.test(sheet_name)) {
          sheet_name = '"' + sheet_name + '"';
        }
        const label = sheet_name + '!' + area.spreadsheet_label;

        // <definedName name="fortran">Sheet1!$C$3</definedName>
        const element = Element('definedName', {name});
        element.text = label;
        names.append(element);
      }
      else {
        console.warn('named range missing sheet ID');
      }

    }


  }

  /**
   * clone sheet 0 so we have X total sheets
   */
  public InsertSheets(total_sheet_count: number) {
    if (!this.dom) throw new Error('missing dom');
    if (!this.rels_dom) throw new Error('missing rels_dom');

    let next_rel_index = 1;
    const NextRel = () => {
      for(;;) {
        const rel = `rId${next_rel_index++}`;
        if (!this.rels[rel]) return rel;
      }
    };

    // for each sheet we add, we need to insert it in the list of
    // sheets (in workbook.xml) and insert a relationship (in
    // workbook.xml.rels).

    while (this.sheets.length < total_sheet_count) {

      const index = this.sheets.length;
      const path = `worksheets/sheet${index + 1}.xml`;
      const rel = NextRel();
      const type = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';

      // console.info('inserting sheet', index);

      this.rels[rel] = {
        target: path,
        type,
        id: rel,
      };

      const relationship = ElementTree.SubElement(this.rels_dom.getroot(), 'Relationship');
      relationship.set('Id', rel);
      relationship.set('Type', type);
      relationship.set('Target', path);

      const name = 'Sheet' + (index + 1);

      const sheets = this.dom.find('./sheets');
      if (sheets) {
        const sheet_element = ElementTree.SubElement(sheets, 'sheet');
        sheet_element.set('name', name);
        sheet_element.set('sheetId', (index + 1).toString());
        sheet_element.set('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id', rel);
      }

      // insert sheet
      const worksheet = new Sheet({
        name,
        id: Number(index + 1),
        rid: rel });

      worksheet.shared_strings = this.shared_strings;
      worksheet.xml = this.sheets[0].xml;
      worksheet.path = 'xl/' + path;
      worksheet.rels_path = `xl/worksheets/_rels/sheet${index + 1}.xml.rels`;
      worksheet.Parse();

      this.sheets.push(worksheet);

    }

  }

  /**
   *
   */
  public async Init(zip?: JSZip, preparse = false, read_rels = false){

    // let wb = this;
    if (zip) { this.zip = zip; }

    if (!this.zip) throw new Error('missing zip');

    // Drawing.ResetIndexes();
    Drawing.next_drawing_index = 1;
    Chart.next_chart_index = 1;

    // read rels
    let data = await this.zip.file( 'xl/_rels/workbook.xml.rels')?.async('text') as string;

    this.rels_dom = ElementTree.parse(data);
    this.rels = {};

    this.rels_dom.findall('./Relationship').forEach((rel) => {
      const rid = rel.attrib.Id;
      if (rid) {
        this.rels[rid] = {
          id: rel.attrib.Id,
          type: rel.attrib.Type,
          target: rel.attrib.Target };
      }
    });

    // read workbook
    data = await this.zip.file('xl/workbook.xml')?.async('text') as string;

    await this.ReadStringsTable();
    await this.ReadTheme();
    await this.ReadStyles();

    // create initial sheets; use relationship (rid) to map
    this.dom = ElementTree.parse(data);
    this.sheets = []; // {};

    this.dom.findall('./sheets/sheet').forEach((sheet) => {
      const name = sheet.attrib.name;
      if (name) {
        const worksheet = new Sheet({
          // wb: wb,
          name: sheet.attrib.name,
          id: Number(sheet.attrib.sheetId),
          rid: sheet.attrib['r:id']});
        
        worksheet.shared_strings = this.shared_strings;
        // this.sheets[name] = worksheet;
        this.sheets.push(worksheet);
      }
    });

    // await this.GetWorksheets(Object.keys(this.sheets).slice(0), preparse);
    await this.GetWorksheets(preparse, read_rels);

  }

}
