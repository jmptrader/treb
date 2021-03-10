
import { TextPartFlag, ICellAddress, Style, ValueType, Cell, Area, Size, Rectangle, 
         Theme, ThemeColor, ThemeColor2 } from 'treb-base-types';

import { Tile } from '../types/tile';

import { FontMetricsCache } from '../util/font_metrics_cache';
import { BaseLayout, TileRange } from '../layout/base_layout';
import { DataModel } from '../types/data_model';
import { GridOptions } from '../types/grid_options';

interface OverflowCellInfo {
  address: ICellAddress;
  cell: Cell;
  border: Rectangle;
  background: Rectangle;
  grid: Rectangle;
}

interface RenderTextPart {
  text: string;
  hidden: boolean;
  width: number;

  // adding optional layout info (for hyperlink, basically)

  top?: number;
  left?: number;
  height?: number;
}

interface PreparedText {
  strings: RenderTextPart[];
  single: boolean;
  width: number;
  format?: string;
}

interface RenderCellResult {

  tile_overflow_bottom?: boolean;
  tile_overflow_right?: boolean;

  // this can happen if a cell overflows to the left.
  tile_overflow_left?: boolean;

  width?: number;
  height?: number;
  left?: number;

}

interface OverflowRecord {
  head: ICellAddress;
  area: Area;
  tile: Tile;
}

export class TileRenderer {

  protected last_font?: string;
  protected readonly cell_edge_buffer = 4;

  /**
   * a record of cell overflows, also used for merges if they cross tile
   * boundaries. on render, we check if an overflow(ed) cell is dirty; if
   * so, this forces update of dependent cells.
   */
  protected overflow_areas: OverflowRecord[] = [];

  protected buffer_canvas: HTMLCanvasElement;
  protected buffer_context!: CanvasRenderingContext2D;
  protected buffer_canvas_size: Size = { width: 256, height: 256 };

  constructor(
    protected theme: Theme,
    protected layout: BaseLayout,
    protected model: DataModel,
    protected options: GridOptions, ) {

    this.buffer_canvas = document.createElement('canvas');
    this.buffer_canvas.width = this.buffer_canvas_size.width;
    this.buffer_canvas.height = this.buffer_canvas_size.height;

    const context = this.buffer_canvas.getContext('2d', { alpha: false });

    if (context) {
      const scale = this.layout.dpr;
      this.buffer_context = context;
      this.buffer_context.setTransform(scale, 0, 0, scale, 0, 0);
      this.buffer_context.textAlign = 'left';
      this.buffer_context.textBaseline = 'alphabetic';
    }

  }

  /**
   * when drawing to the buffered canvas, (1) ensure it's large enough,
   * and (2) set transform as necessary (we may be overflowing to the left).
   */
  public EnsureBuffer(width = 0, height = 0, offset = 0): void {

    // console.info('eb', width, height, offset);

    const scale = this.layout.dpr;
    width = width * scale;
    height = height * scale;
    offset = offset * scale;

    if (width > this.buffer_canvas_size.width
      || height > this.buffer_canvas_size.height) {

      this.buffer_canvas_size.width = Math.max(Math.ceil(width / 256) * 256, this.buffer_canvas_size.width);
      this.buffer_canvas_size.height = Math.max(Math.ceil(height / 256) * 256, this.buffer_canvas_size.height);

      // console.info('size ->', this.buffer_canvas_size);

      this.buffer_canvas.width = this.buffer_canvas_size.width;
      this.buffer_canvas.height = this.buffer_canvas_size.height;

      const context = this.buffer_canvas.getContext('2d', { alpha: false });

      if (context) {
        this.buffer_context = context;
        this.buffer_context.textAlign = 'left';
        this.buffer_context.textBaseline = 'alphabetic';
      }

    }

    this.buffer_context.setTransform(scale, 0, 0, scale, offset, 0);

  }

  /**
   * check all overflow areas. if any elements are dirty, mark all elements
   * as dirty (FIXME: and remove the list?)
   */
  public OverflowDirty(full_tile = false): void {

    const mutated = [];

    for (const overflow of this.overflow_areas) {
      const row = overflow.area.start.row;
      let dirty = full_tile; // false;
      if (!dirty) {
        for (let column = overflow.area.start.column; !dirty && column <= overflow.area.end.column; column++) {
          const cell = this.model.active_sheet.cells.GetCell({ row, column }, false);
          dirty = !!(cell && cell.render_dirty);
        }
      }
      if (dirty) {
        for (let column = overflow.area.start.column; column <= overflow.area.end.column; column++) {
          const cell = this.model.active_sheet.cells.GetCell({ row, column }, false);
          if (cell) {
            cell.render_dirty = true;
            if (cell.renderer_data && cell.renderer_data.overflowed) {
              cell.renderer_data = undefined;
            }
          }
        }
        overflow.tile.dirty = true;
      }
      else mutated.push(overflow);
    }

    this.overflow_areas = mutated;

  }


  /**
   * 
   */
  public RenderCorner(/* selection: GridSelection */): void {

    const corner = this.layout.corner_canvas;
    const context = (corner as HTMLCanvasElement).getContext('2d', { alpha: false });
    if (!context) throw new Error('invalid context');

    /*
    const font_metrics = FontMetricsCache.get({
      font_face: this.theme.interface_font_face,
      // font_size: this.theme.interface_font_size,
      font_size_unit: this.theme.interface_font_size_unit,
      font_size_value: this.theme.interface_font_size_value,
    }, this.layout.scale);
    */
   const font_metrics = FontMetricsCache.get(this.theme.headers || {}, this.layout.scale);

    const scale = this.layout.dpr;
    const header_size = this.layout.header_offset;

    let x = header_size.x;
    for (let i = 0; i < this.model.active_sheet.freeze.columns; i++) {
      x += this.layout.ColumnWidth(i);
    }

    let y = header_size.y;
    for (let i = 0; i < this.model.active_sheet.freeze.rows; i++) {
      y += this.layout.RowHeight(i);
    }

    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.fillStyle = // this.theme.headers?.background || '';
      this.theme.headers?.fill ? ThemeColor(this.theme, this.theme.headers.fill) : '';

    context.fillRect(0, 0, x, header_size.y);
    context.fillRect(0, 0, header_size.x, y);

    context.strokeStyle = this.theme.grid_color || '';
    context.beginPath();
    context.moveTo(header_size.x - 0.5, 0);
    context.lineTo(header_size.x - 0.5, y);
    context.moveTo(0, header_size.y - 0.5);
    context.lineTo(x, header_size.y - 0.5);
    context.stroke();

    if (!this.model.active_sheet.freeze.columns && !this.model.active_sheet.freeze.rows) return;

    // NOTE: if headers are hidden (which is done by setting width/height to
    // 0 or 1 pixel) we don't want to render them here.

    // copying from RenderHeaders method. FIXME: unify

    context.textAlign = 'center';
    context.textBaseline = 'middle';

    // const size = this.theme.interface_font_size_value ? this.theme.interface_font_size_value * this.layout.scale : '';
    // context.font = `${size}${this.theme.interface_font_size_unit} ${this.theme.interface_font_face}`;
    context.font = Style.Font(this.theme.headers||{});

    // context.fillStyle = this.theme.headers?.text_color || '';
    context.fillStyle = ThemeColor(this.theme, this.theme.headers?.text);

    if (this.model.active_sheet.freeze.rows && this.layout.header_offset.x > 1) {

      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.translate(0, header_size.y);
      context.beginPath();
      context.moveTo(0, 0 - 0.5);
      context.lineTo(header_size.x, 0 - 0.5);

      let row_index = 0;
      for (; row_index < this.model.active_sheet.freeze.rows; row_index++) {
        const height = this.layout.RowHeight(row_index);

        //context.fillStyle = this.theme.headers?.text_color || '';
        context.fillStyle = ThemeColor(this.theme, this.theme.headers?.text);

        if (height >= font_metrics.block) {
          context.fillText(`${row_index + 1}`,
            header_size.x / 2, height / 2);
        }
        /*
        if (!selection.empty && selection.area.ContainsRow(row_index)) {
          context.fillStyle = this.theme.selected_header_highlight_color || '';
          context.fillRect(0, 0, header_size.x, height);
          context.fillStyle = this.theme.primary_selection_color || '';
          context.fillRect(header_size.x - 2.5, -0.5, 2, height + 1);
          context.moveTo(0, height - 0.5);
          context.lineTo(header_size.x - 2.5, height - 0.5);
        }
        else */
        {
          // if (row_index < this.model.sheet.freeze.rows - 1) {
          context.moveTo(0, height - 0.5);
          context.lineTo(header_size.x, height - 0.5);
          // }
        }
        context.translate(0, height);
      }

      context.strokeStyle = this.theme.grid_color || '';
      context.stroke();

      /*
      context.setLineDash([3, 2]);
      context.beginPath();
      context.moveTo(0, -0.5);
      context.lineTo(header_size.x, -0.5);
      context.stroke();
      context.setLineDash([]);
      */

    }

    if (this.model.active_sheet.freeze.columns && this.layout.header_offset.y > 1) {

      context.strokeStyle = this.theme.grid_color || '';
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.translate(header_size.x, 0);
      context.beginPath();
      context.moveTo(0 - 0.5, 0);
      context.lineTo(0 - 0.5, header_size.y);

      let column_index = 0;
      for (; column_index < this.model.active_sheet.freeze.columns; column_index++) {
        const width = this.layout.ColumnWidth(column_index);
        const text = Area.ColumnToLabel(column_index);
        const metrics = context.measureText(text);
        if (width > metrics.width) {

          // context.fillStyle = this.theme.headers?.text_color || '';
          context.fillStyle = ThemeColor(this.theme, this.theme.headers?.text);

          context.fillText(text, width / 2, header_size.y / 2);
        }
        /*
        if (!selection.empty && selection.area.ContainsColumn(column_index)) {
          context.fillStyle = this.theme.selected_header_highlight_color || '';
          context.fillRect(0, 0, width, header_size.y);
          context.fillStyle = this.theme.primary_selection_color || '';
          context.fillRect(-0.5, header_size.y - 2.5, width + 1, 2);
          context.moveTo(width - 0.5, 0);
          context.lineTo(width - 0.5, header_size.y - 2.5);
        }
        else */
        {
          // if (column_index < this.model.sheet.freeze.columns - 1) {
          context.moveTo(width - 0.5, 0);
          context.lineTo(width - 0.5, header_size.y);
          // }
        }
        context.translate(width, 0);
      }

      context.stroke();

      /*
      context.setLineDash([3, 2]);
      context.beginPath();
      context.moveTo(-0.5, 0);
      context.lineTo(-0.5, header_size.y);
      context.stroke();
      context.setLineDash([]);
      */

    }

    /////


  }

  /**
   */
  public RenderHeaders(tiles: TileRange /*, selection: GridSelection*/, force = false): void {

    const scale = this.layout.dpr;

    const header_size = this.layout.header_offset;

    /*
    const font_metrics = FontMetricsCache.get({
      font_face: this.theme.interface_font_face,
      // font_size: this.theme.interface_font_size,
      font_size_unit: this.theme.interface_font_size_unit,
      font_size_value: this.theme.interface_font_size_value,
    }, this.layout.scale);
    */
    const font_metrics = FontMetricsCache.get(this.theme.headers || {}, this.layout.scale);

    for (let column = tiles.start.column; column <= tiles.end.column; column++) {

      const tile = this.layout.column_header_tiles[column];

      const context = tile.getContext('2d', { alpha: false });
      if (!context) continue;
      context.setTransform(scale, 0, 0, scale, 0, 0);

      if (tile.dirty || force) {

        context.fillStyle = // this.theme.headers?.background || '';
          this.theme.headers?.fill ? ThemeColor(this.theme, this.theme.headers.fill) : '';

        context.fillRect(0, 0, tile.logical_size.width, this.layout.header_offset.y);

        context.textAlign = 'center';
        context.textBaseline = 'middle';

        // const size = this.theme.interface_font_size_value ? this.theme.interface_font_size_value * this.layout.scale : '';
        // context.font = `${size}${this.theme.interface_font_size_unit} ${this.theme.interface_font_face}`;
        context.font = Style.Font(this.theme.headers||{});

        // context.fillStyle = this.theme.headers?.text_color || '';
        context.fillStyle = ThemeColor(this.theme, this.theme.headers?.text);
        context.strokeStyle = this.theme.grid_color || '';

        context.beginPath();
        context.moveTo(0, header_size.y - 0.5);
        context.lineTo(tile.logical_size.width, header_size.y - 0.5);

        let column_index = tile.first_cell.column;
        for (; column_index <= tile.last_cell.column; column_index++) {
          const width = this.layout.ColumnWidth(column_index);
          const text = Area.ColumnToLabel(column_index);
          const metrics = context.measureText(text);
          if (width > metrics.width) {
            // context.fillStyle = this.theme.headers?.text_color || '';
            context.fillStyle = ThemeColor(this.theme, this.theme.headers?.text);
            context.fillText(text, width / 2, header_size.y / 2);
          }
          /*
          if (!selection.empty && selection.area.ContainsColumn(column_index)) {
            context.fillStyle = this.theme.selected_header_highlight_color || '';
            context.fillRect(0, 0, width, header_size.y);
            context.fillStyle = this.theme.primary_selection_color || '';
            context.fillRect(-0.5, header_size.y - 2.5, width + 1, 2);
            context.moveTo(width - 0.5, 0);
            context.lineTo(width - 0.5, header_size.y - 2.5);
          }
          else
          */
          {
            context.moveTo(width - 0.5, 0);
            context.lineTo(width - 0.5, header_size.y);
          }
          context.translate(width, 0);
        }

        context.stroke();
        tile.dirty = false;
      }

    }

    for (let row = tiles.start.row; row <= tiles.end.row; row++) {

      const tile = this.layout.row_header_tiles[row];
      if (tile.dirty || force) {

        const context = tile.getContext('2d', { alpha: false });
        if (!context) continue;
        context.fillStyle = // this.theme.headers?.background || '';
          this.theme.headers?.fill ? ThemeColor(this.theme, this.theme.headers.fill) : '';

        context.setTransform(scale, 0, 0, scale, 0, 0);
        // context.fillRect(0, 0, tile.logical_size.width, tile.logical_size.height);
        context.fillRect(0, 0, this.layout.header_offset.x, tile.logical_size.height);

        context.textAlign = 'center';
        context.textBaseline = 'middle';
        
        // const size = this.theme.interface_font_size_value ? this.theme.interface_font_size_value * this.layout.scale : '';
        // context.font = `${size}${this.theme.interface_font_size_unit} ${this.theme.interface_font_face}`;
        context.font = Style.Font(this.theme.headers||{});

        // context.fillStyle = this.theme.headers?.text_color || '';
        context.fillStyle = ThemeColor(this.theme, this.theme.headers?.text);

        context.strokeStyle = this.theme.grid_color || '';

        context.beginPath();
        context.moveTo(header_size.x - 0.5, 0);
        context.lineTo(header_size.x - 0.5, tile.logical_size.height);

        let row_index = tile.first_cell.row;
        for (; row_index <= tile.last_cell.row; row_index++) {
          const height = this.layout.RowHeight(row_index);
          //context.fillStyle = this.theme.headers?.text_color || '';
          context.fillStyle = ThemeColor(this.theme, this.theme.headers?.text);

          if (height >= font_metrics.block) {
            context.fillText(`${row_index + 1}`,
              header_size.x / 2, height / 2);
          }
          /*
          if (!selection.empty && selection.area.ContainsRow(row_index)) {
            context.fillStyle = this.theme.selected_header_highlight_color || '';
            context.fillRect(0, 0, header_size.x, height);
            context.fillStyle = this.theme.primary_selection_color || '';
            context.fillRect(header_size.x - 2.5, -0.5, 2, height + 1);
            context.moveTo(0, height - 0.5);
            context.lineTo(header_size.x - 2.5, height - 0.5);
          }
          else */
          {
            context.moveTo(0, height - 0.5);
            context.lineTo(header_size.x, height - 0.5);
          }
          context.translate(0, height);
        }

        context.strokeStyle = this.theme.grid_color || '';
        context.stroke();
        tile.dirty = false;
      }
    }

    if (this.model.active_sheet.freeze.rows || this.model.active_sheet.freeze.columns) {
      this.RenderCorner();
    }

  }

  /**
   * 
   * @param tile starting tile
   * @param scale scale
   * @param dx tile offset, in tiles
   * @param dy tile offset, in tiles
   * @param left (original) translation, in scaled pixels
   * @param top (original) translation, in scaled pixels
   * @param result buffer info
   */
  public CopyToAdjacent(
    tile: Tile,
    scale: number,
    dx: -1 | 0 | 1,
    dy: -1 | 0 | 1,
    left: number,
    top: number,
    result: RenderCellResult): void {

    const adjacent = this.layout.AdjacentTile(tile, dy, dx);
    if (!adjacent) return; // FIXME: warn?

    let x = left;
    let y = top;

    if (dx > 0) {
      x = left - (tile.pixel_end.x - tile.pixel_start.x) * scale;
    }
    else if (dx < 0) {
      x = left + (adjacent.pixel_end.x - adjacent.pixel_start.x) * scale;
    }
    if (dy > 0) {
      y = top - (tile.pixel_end.y - tile.pixel_start.y) * scale;
    }

    const context = adjacent.getContext('2d', { alpha: false });
    if (context) {
      context.setTransform(scale, 0, 0, scale, x, y);
      context.drawImage(this.buffer_canvas,
        0, 0, (result.width || 0) * scale, (result.height || 0) * scale,
        result.left || 0, 0, result.width || 0, result.height || 0);
    }

  }

  /** render a tile */
  public Render(tile: Tile): void {

    const context = tile.getContext('2d', { alpha: false });
    if (!context) { return; } // should throw

    const scale = this.layout.dpr;

    // const render_list: Array<{row: number, column: number, cell: Cell}> = [];

    this.last_font = undefined;
    context.setTransform(scale, 0, 0, scale, 0, 0);

    let left = 0;
    let top = 0;

    // console.info('r', tile.first_cell);

    for (let column = tile.first_cell.column; column <= tile.last_cell.column; column++) {
      const width = this.layout.ColumnWidth(column);
      if (!width) continue;
      top = 0;
      for (let row = tile.first_cell.row; row <= tile.last_cell.row; row++) {
        const height = this.layout.RowHeight(row);
        if (height) {

          context.setTransform(scale, 0, 0, scale, left, top);
          const cell = this.model.active_sheet.CellData({ row, column });

          if (tile.needs_full_repaint || cell.render_dirty) {

            const result = this.RenderCell(tile, cell, context, { row, column }, width, height);
            // render_list.push({row, column, cell});

            if (result.tile_overflow_right) {
              this.CopyToAdjacent(tile, scale, 1, 0, left, top, result);
            }
            if (result.tile_overflow_left) {
              this.CopyToAdjacent(tile, scale, -1, 0, left, top, result);
            }
            if (result.tile_overflow_bottom) {
              this.CopyToAdjacent(tile, scale, 0, 1, left, top, result);
            }

          }

        }
        top += (height * scale);
      }
      left += (width * scale);
    }

    if (!this.model.active_sheet.freeze.rows && !this.model.active_sheet.freeze.columns) return; // render_list;

    // paint to headers

    let copy_height = 0;
    let copy_width = 0;

    if (tile.first_cell.row <= this.model.active_sheet.freeze.rows - 1) {
      for (let i = tile.first_cell.row; i < this.model.active_sheet.freeze.rows && i <= tile.last_cell.row; i++) {
        copy_height += this.layout.RowHeight(i);
      }
    }
    if (tile.first_cell.column <= this.model.active_sheet.freeze.columns - 1) {
      for (let i = tile.first_cell.column; i < this.model.active_sheet.freeze.columns && i <= tile.last_cell.column; i++) {
        copy_width += this.layout.ColumnWidth(i);
      }
    }

    if (copy_height) {

      // get tile header
      const header = this.layout.frozen_row_tiles[tile.tile_position.column];
      if (!header) throw new Error('can\'t find matching header tile');

      const header_context = header.getContext('2d', { alpha: true });
      if (!header_context) throw new Error('header context failed');

      // FIXME: offset for !first tile

      header_context.setTransform(scale, 0, 0, scale, 0, 0); // this.model.sheet.header_offset.y * scale);

      header_context.drawImage(tile, 0, 0, tile.logical_size.width * scale,
        copy_height * scale, 0, 0, tile.logical_size.width, copy_height);

    }
    if (copy_width) {

      // get tile header
      const header = this.layout.frozen_column_tiles[tile.tile_position.row];
      if (!header) throw new Error('can\'t find matching header tile');

      const header_context = header.getContext('2d', { alpha: true });
      if (!header_context) throw new Error('header context failed');

      // FIXME: offset for !first tile

      header_context.setTransform(scale, 0, 0, scale, 0, 0);

      header_context.drawImage(tile, 0, 0, copy_width * scale,
        tile.logical_size.height * scale, 0, 0, copy_width, tile.logical_size.height);

    }
    if (copy_width && copy_height) {

      const corner_context = this.layout.corner_canvas.getContext('2d', { alpha: 'false' }) as CanvasRenderingContext2D;
      if (!corner_context) throw new Error('corner context failed');

      // FIXME: offset for !first tile

      corner_context.setTransform(scale, 0, 0, scale,
        this.layout.header_offset.x * scale,
        this.layout.header_offset.y * scale);

      corner_context.drawImage(tile, 0, 0, copy_width * scale,
        copy_height * scale, 0, 0, copy_width, copy_height);

    }

    return; // render_list;

  }

  /**
   * split and measure text. can be cached. there are actually two completely
   * separate operations here, which we're consolidating for convenience (and
   * because they never overlap).
   *
   * NOTE: style font must already be set in context
   */
  protected PrepText(context: CanvasRenderingContext2D, cell: Cell, cell_width: number /*, override_text?: string*/ ): PreparedText {

    const strings: RenderTextPart[] = [];
    const style: Style.Properties = cell.style || {};

    let pad_entry: RenderTextPart | undefined;
    let max_width = 0;
    let composite_width = 0;
    let single = false;

    let override_formatting: string | undefined;
    let formatted = cell.formatted;

    /*
    if (typeof override_text === 'string') {
      formatted = override_text;
    }
    */

    if (Array.isArray(formatted)) {

      // type 1 is a multi-part formatted string; used for number formats.
      // we support invisible characters and padded (expanded) characters

      // this is a single line, with number formatting

      for (const part of formatted) {
        if (part.flag === TextPartFlag.formatting) {
          override_formatting = part.text;
          continue;
        }

        const mt_width = context.measureText(part.text).width;
        const render_part = { width: mt_width, text: part.text, hidden: part.flag === TextPartFlag.hidden };
        strings.push(render_part);
        if (part.flag === TextPartFlag.padded) {
          pad_entry = render_part;
        }
        else {
          composite_width += mt_width;
        }
      }

      if (pad_entry) {

        const text = pad_entry.text;
        const text_width = pad_entry.width;
        const balance = cell_width - composite_width - (2 * this.cell_edge_buffer);

        pad_entry.width = Math.max(0, balance);

        if (balance > 0) {
          const count = Math.floor(balance / text_width);
          for (let i = 1; i < count; i++) {
            pad_entry.text += text;
          }
          composite_width = cell_width - (2 * this.cell_edge_buffer);
        }
        else {
          pad_entry.text = '';
        }

      }

      max_width = composite_width;
      single = true;

    }
    else if (formatted === '') {

      // undefined cells return this value; we don't need to do any calculation

      strings.push({ text: '', hidden: false, width: 0 });

    }
    else if (formatted) {

      // type 2 is a single string, but may be split into newlines either
      // explicitly or implicitly via wrap

      // ALSO we don't show leading apostrophes, as those indicate a string

      if (cell.type === ValueType.string && formatted[0] === '\'') {
        formatted = formatted.slice(1);
      }

      let lines = formatted.split(/\n/); // cell.formatted.split(/\n/);
      if (style.wrap) {

        const bounded_width = cell_width - (2 * this.cell_edge_buffer);

        const wrapped: string[] = [];
        lines.forEach((base_line) => {

          // temp: word split
          const words = base_line.match(/\S+\s*/g); // preserve extra whitespace on the same line...
          if (words && words.length) {
            let line = '';
            do {
              // add word
              const test = (line + words[0]).trim();

              // measure
              const width = context.measureText(test).width;

              if (width < bounded_width) {
                // fits? consume, continue
                line = line + words[0]; // add trailing whitespace for now
                words.shift();
              }
              else if (!line) {
                // doesn't fit, but first word: consume, push
                wrapped.push(test.trim());
                words.shift();
                line = '';
              }
              else {
                // doesn't fit: push existing line, loop
                wrapped.push(line.trim()); // remove trailing whitespace in this case
                line = '';
              }

            }
            while (words.length);
            if (line) {
              wrapped.push(line.trim()); // remove trailing whitespace in this case
            }
          }
          else {
            // blank line?
            wrapped.push('');
          }
        });
        lines = wrapped;
      }

      for (const line of lines) {
        const width = context.measureText(line).width;
        max_width = Math.max(max_width, width);
        strings.push({ text: line, hidden: false, width });
      }

    }

    if (override_formatting) {
      return { strings, width: max_width, single, format: override_formatting };
    }

    return { strings, width: max_width, single };

  }

  protected ResolveColors(style: Style.Properties): Style.Properties {

    const resolved = {...style};
    resolved.text = { text: ThemeColor(this.theme, style.text) };

    // TODO: other colors

    return resolved;

  }

  protected RenderCellBorders(
    address: ICellAddress,
    context: CanvasRenderingContext2D,
    style: Style.Properties,
    left = 0, top = 0, width = 0, height = 0): void {

    // edges are complicated. borders cover grid lines. fill also covers
    // grid lines, in all four directions. the bottom and right cells should
    // control, which is handy because we usually paint in that order, but 
    // sometimes we are painting out of order so we still need to think about
    // it.

    // borders take precedence over fills for corners. so a border can
    // "bite into" a fill that covers multiple cells.

    // --- first calculate ---

    // this is a field for the background between a double border; generally
    // speaking it should be the cell background color of the cell the border
    // belongs to...

    let double_border_center = '';

    // this is a flag because we check more than once

    const composite = { ...style };

    const valid_fill = Style.ValidColor(style.fill);

    const edges: {
      above: Style.Properties,
      below: Style.Properties,
      left: Style.Properties,
      right: Style.Properties,
    } = {
      below: this.model.active_sheet.CellStyleData({row: address.row + 1, column: address.column}) || {},
      right: this.model.active_sheet.CellStyleData({row: address.row, column: address.column + 1}) || {},
      above: address.row ? this.model.active_sheet.CellStyleData({row: address.row - 1, column: address.column}) || {} : {},
      left: address.column ? this.model.active_sheet.CellStyleData({row: address.row, column: address.column - 1}) || {} : {},
    };

    // if the cell underneath has a top border, that overrides our bottom
    // border (although these should be normalized somewhere?)
    
    if (edges.below.border_top) {
      composite.border_bottom = edges.below.border_top;
      composite.border_bottom_fill = edges.below.border_bottom_fill;

      if (edges.below.border_top === 2) {
        double_border_center = 
          ThemeColor2(this.theme, edges.below.fill) || 
          ThemeColor2(this.theme, this.theme.grid_cell?.fill) || '#fff';
      }

    }
    else if (style.border_bottom === 2) {
      double_border_center = 
        ThemeColor2(this.theme, style.fill) || 
        ThemeColor2(this.theme, this.theme.grid_cell?.fill) || '#fff';
    }

    // if we still don't have a bottom border, check fill, starting with
    // the cell underneath, because that controls.
    
    if (!composite.border_bottom) {
      if (Style.ValidColor(edges.below.fill)) {
        composite.border_bottom = 1;
        composite.border_bottom_fill = edges.below.fill;
      }
      else if (valid_fill) {
        composite.border_bottom = 1;
        composite.border_bottom_fill = style.fill;
      }
    }

    // now do the same thing with the cell to the right...

    if (edges.right.border_left) {
      composite.border_right = edges.right.border_left;
      composite.border_right_fill = edges.right.border_left_fill;
    }

    if (!composite.border_right) {
      if (Style.ValidColor(edges.right.fill)) {
        composite.border_right = 1;
        composite.border_right_fill = edges.right.fill;
      }
      else if (valid_fill) {
        composite.border_right = 1;
        composite.border_right_fill = style.fill;
      }
    }

    // for top and left, border overrides fill but our fill controls 

    if (!composite.border_top) {
      if (edges.above.border_bottom) {
        composite.border_top = edges.above.border_bottom;
        composite.border_top_fill = edges.above.border_bottom_fill;

        if (edges.above.border_bottom === 2) {
          double_border_center = 
            ThemeColor2(this.theme, edges.above.fill) || 
            ThemeColor2(this.theme, this.theme.grid_cell?.fill) || '#fff';
        }

      }
      else if (valid_fill) {
        composite.border_top = 1;
        composite.border_top_fill = style.fill;
      }
      else if (Style.ValidColor(edges.above.fill)) {
        composite.border_top = 1;
        composite.border_top_fill = edges.above.fill;
      }
    }
    
    if (!composite.border_left) {
      if (edges.left.border_right) {
        composite.border_left = edges.left.border_right;
        composite.border_left_fill = edges.left.border_right_fill;
      }
      else if (valid_fill) {
        composite.border_left = 1;
        composite.border_left_fill = style.fill;
      }
      else if (Style.ValidColor(edges.left.fill)) {
        composite.border_left = 1;
        composite.border_left_fill = edges.left.fill;
      }
    }

    // --- then paint ---

    context.lineWidth = 1; // ??

    if (composite.border_left) {
      const x = (address.column === 0 ? 0.5 : -0.5) + left;
      context.strokeStyle = ThemeColor2(this.theme, composite.border_left_fill);      
      context.beginPath();
      context.moveTo(x, top - 1);
      context.lineTo(x, top + height);
      context.stroke();
    }

    if (composite.border_top) {
      const y = (address.row === 0 ? 0.5 : -0.5) + top;
      if (composite.border_top === 1) {
        context.strokeStyle = ThemeColor2(this.theme, composite.border_top_fill);      
        context.beginPath();
        context.moveTo(left - 1, y);
        context.lineTo(left + width, y);
        context.stroke();
      }
      else {

        context.strokeStyle = double_border_center;
        context.beginPath();
        context.moveTo(left - 1, y);
        context.lineTo(left + width, y);
        context.stroke();

        context.strokeStyle = ThemeColor2(this.theme, composite.border_top_fill);      
        context.beginPath();
        context.moveTo(left - 1, y - 1);
        context.lineTo(left + width, y - 1);
        context.moveTo(left - 1, y + 1);
        context.lineTo(left + width, y + 1);
        context.stroke();
      }
    }

    if (composite.border_bottom) {

      const y = top + height - 0.5;

      if (composite.border_bottom === 1) {
        context.strokeStyle = ThemeColor2(this.theme, composite.border_bottom_fill);      
        context.beginPath();
        context.moveTo(left - 1, y);
        context.lineTo(left + width, y);
        context.stroke();
      }
      else {

        context.strokeStyle = double_border_center;
        context.beginPath();
        context.moveTo(left - 1, y);
        context.lineTo(left + width, y);
        context.stroke();

        context.strokeStyle = ThemeColor2(this.theme, composite.border_bottom_fill);      
        context.beginPath();
        context.moveTo(left - 1, y - 1);
        context.lineTo(left + width, y - 1);
        context.moveTo(left - 1, y + 1);
        context.lineTo(left + width, y + 1);
        context.stroke();
      }
    }

    if (composite.border_right) {
      const x = left + width - 0.5;
      context.strokeStyle = ThemeColor2(this.theme, composite.border_right_fill);      
      context.beginPath();
      context.moveTo(x, top - 1);
      context.lineTo(x, top + height);
      context.stroke();

    }

  }

  protected RenderCellBackground(
    note: boolean,
    address: ICellAddress,
    context: CanvasRenderingContext2D,
    style: Style.Properties,
    width: number, height: number): void {

    // so here we draw the background and the bottom and right grid edges.
    // fill is enclosed here, the border method has logic for border colors,
    // because it turns out to be complicated.
    
    context.fillStyle = this.theme.grid_color;
    context.fillRect(0, 0, width, height);

    const fill = ThemeColor2(this.theme, style.fill);
    if (fill) {
      context.fillStyle = fill;
      context.fillRect(0, 0, width - 1, height - 1);
    }
    else {
      context.fillStyle = ThemeColor(this.theme, this.theme.grid_cell?.fill) || '#fff';
      context.fillRect(0, 0, width - 1, height - 1);
    }

    // why is this here? (it's rendered as background, I guess)

    if (note) {

      const offset_x = 2;
      const offset_y = 1;
      const length = 8;

      // FIXME: why is the default in here, and not in theme defaults?
      // actually it is in theme defaults, probably was here first.

      context.fillStyle = this.theme.note_marker_color;
      context.beginPath();
      context.moveTo(width - offset_x, offset_y);
      context.lineTo(width - offset_x - length, offset_y);
      context.lineTo(width - offset_x, offset_y + length);
      context.lineTo(width - offset_x, offset_y);
      context.fill();
    }

    this.RenderCellBorders(address, context, style, 0, 0, width, height);

  }

  /**
   * refactoring render to allow rendering to buffered canvas, in the
   * case of tile overflow. this is problematic because as the code stands
   * now, it paints before determining if there's an overflow. so we need
   * to move some paint calls around.
   */
  protected RenderCell(
    tile: Tile,
    cell: Cell,
    context: CanvasRenderingContext2D,
    address: ICellAddress,
    width: number,
    height: number): RenderCellResult {

    const result: RenderCellResult = {};

    // preserve the flag, then unset so we don't have to track around

    const dirty = cell.render_dirty;
    cell.render_dirty = false;

    // special case for overflows (this has been set by someone to the left)

    if (tile.needs_full_repaint &&
      cell.renderer_data?.overflowed) {

      return {};
    }

    const style: Style.Properties = cell.style ? {...cell.style} : {};

    if (cell.merge_area) {

      if ((address.row === cell.merge_area.start.row) &&
        (address.column === cell.merge_area.start.column)) {

        for (let column = cell.merge_area.start.column + 1; column <= cell.merge_area.end.column; column++) {
          width += this.layout.ColumnWidth(column);
        }

        for (let row = cell.merge_area.start.row + 1; row <= cell.merge_area.end.row; row++) {
          height += this.layout.RowHeight(row);
        }

        // get last cell for borders

        if (cell.merge_area.count > 1) {
          const end_cell_style = this.model.active_sheet.CellStyleData(cell.merge_area.end);
          if (end_cell_style) {
            style.border_bottom = end_cell_style.border_bottom;
            style.border_right = end_cell_style.border_right;
            style.border_bottom_fill = end_cell_style.border_bottom_fill;
            style.border_right_fill = end_cell_style.border_right_fill;
          }
        }

        // check if we are going to overflow into another tile right or down

        if (cell.merge_area.end.column > tile.last_cell.column) {
          result.tile_overflow_right = true;
        }

        if (cell.merge_area.end.row > tile.last_cell.row) {
          result.tile_overflow_bottom = true;
        }

        // there's an issue with merges that cross tiles and resizing; they
        // don't get painted properly. we can reuse the overflow record list
        // to fix this.

        // NOTE: this refers to _tile_ overflows, not cell overflows. we
        // should change the name to make this clearer.

        if (result.tile_overflow_bottom || result.tile_overflow_right) {
          this.overflow_areas.push({
            tile,
            head: { ...address },
            area: new Area(cell.merge_area.start, cell.merge_area.end),
          });
        }

      }
      else {

        /*
        // there are some unexpected or weird behaviors with borders and
        // merge cells. atm the border is applied to the inner cell, but
        // those cells (and thus the borders) are never rendered. we will
        // render if we're on an edge and there's a border edge.

        // I *think* we only have to worry about the back side (right/bottom)
        // and not the front side... because if the front side has any borders,
        // they'll be applied across all cells in the merge area (because
        // width and height are increased)

        const clone: Style.Properties = {};

        if (style.border_bottom && address.row === cell.merge_area.end.row) {
          clone.border_bottom = style.border_bottom;
          clone.border_bottom_color = style.border_bottom_color;
        }

        if (style.border_right && address.column === cell.merge_area.end.column) {
          clone.border_right = style.border_right;
          clone.border_right_color = style.border_right_color;
        }

        console.info("MERGE ERBS");

        // this paint call is OK (vis a vis the overflow buffer) because this
        // cell will never overflow

        if (clone.border_bottom || clone.border_right) {
          this.RenderCellBorders2(address, context, clone, 0, 0, width, height);
        }
        */

        return {};
      }
    }

    // want to do some surgery here, need to consider any side-effects. 
    
    // specifically, to support hyperlinks, I want to (1) do the text 
    // calculation before calling the cell's render_function (so we can figure 
    // out layout); and (2) let the render function indicate that it does not 
    // want to exit, i.e. it's only a prerender for calc purposes.

    // although that layout calc won't be good enough to account for things
    // like overflow... also here we are just splitting the string, not 
    // generating text boxes (think about justification, wrap)

    // doing this a little differently... render function can pass but can
    // also ask us to preserve layout (text rectangles)

    // let preserve_layout_info = false;
    // let renderer_title: string|undefined;
    // let override_text: string|undefined;

    // ...updating...

    const preserve_layout_info = !!cell.hyperlink;

    if (cell.render_function) {
      this.RenderCellBackground(
        !!cell.note,
        address,
        context, 
        style, 
        width, 
        height);

      // FIXME: what's with the double read here? going to preserve it 
      // for theme color switch, but it's very unclear what it's for

      // it's almost certainly unecessary now... clean up

      // const style_text_color = style.text_color === 'none' ? (this.theme.grid_cell?.text_color ||  '') : style.text_color;

      const style_text_color = style.text === 'none' ? 
          ThemeColor(this.theme, this.theme.grid_cell?.text) : 
          ThemeColor(this.theme, style.text);

      context.strokeStyle = context.fillStyle =
        style_text_color || ThemeColor(this.theme, this.theme.grid_cell?.text);

      // there's an issue with theme colors, the function may not be able
      // to translate so we need to update the style (using a copy) to
      // resolve colors

      const apply_style = this.ResolveColors(style);

      const render_result = cell.render_function.call(undefined, {
        width, height, context, cell, style: apply_style, scale: this.layout.scale || 1,
      });

      if (render_result.handled) {
        return result;
      }

      /*
      if (render_result.metrics) {
        preserve_layout_info = true;
      }

      if (render_result.title) {
        renderer_title = render_result.title;
      }
      
      if (typeof render_result.override_text !== 'undefined') {
        override_text = render_result.override_text;
      }
      */

    }

    // if there's no context, we just need to render the background
    // and border; but it still might be overflowed (via merge)

    if (!cell.formatted) {
      this.RenderCellBackground(
        !!cell.note,
        address,
        (result.tile_overflow_bottom || result.tile_overflow_right) ?
          this.buffer_context : context, style, width, height);
      return result;
    }

    // NOTE: this is OK to do in the original context, even if we're
    // (eventually) painting to the buffer context. just remember to set
    // font in the buffer context.

    const font = Style.Font(style, this.layout.scale);

    if (font !== this.last_font) {
      context.font = this.last_font = font; // set in context so we can measure
    }

    if (dirty || !cell.renderer_data || cell.renderer_data.width !== width || cell.renderer_data.height !== height) {
      cell.renderer_data = { 
        text_data: this.PrepText(context, cell, width), // , override_text), 
        width, 
        height,
      };
      //if (renderer_title) {
      //  cell.renderer_data.title = renderer_title;
      //}
    }

    const text_data = cell.renderer_data.text_data as PreparedText;

    // overflow is always a huge headache. here are the basic rules:

    // (1) only strings can overflow. numbers get ### treatment.
    // (2) wrapped and merged cells cannot overflow.
    // (3) overflow is horizontal only.
    // (4) overflow can extend indefinitely.

    const overflow = text_data.width > (width - 2 * this.cell_edge_buffer);

    let paint_right = width;
    let paint_left = 0;

    let clip = false;

    const is_number = (cell.type === ValueType.number || cell.calculated_type === ValueType.number);

    let horizontal_align = style.horizontal_align;
    if (horizontal_align === Style.HorizontalAlign.None) {
      horizontal_align = is_number ? Style.HorizontalAlign.Right : Style.HorizontalAlign.Left;
    }

    // NOTE: text rendering options (align, baseline) are set globally
    // when the tile is created, so we don't need to set them repeatedly here.

    // we cache some data for drawing backgrounds under overflows, if necessary,
    // so we can do draw calls after we figure out if we need to buffer or not

    // UPDATE: we have a case where there's a super-long string trying to 
    // render/overflow, and it's breaking everything. we need to address some 
    // caps/limits. WIP.

    const overflow_backgrounds: OverflowCellInfo[] = [];

    if (overflow) {

      const can_overflow = (cell.type !== ValueType.number &&
        cell.calculated_type !== ValueType.number &&
        !style.wrap &&
        !cell.merge_area);

      if (can_overflow) {

        // check how far we want to overflow left and right (pixels)

        // FIXME: should be (buffer * 2), no?

        const delta = text_data.width - width + this.cell_edge_buffer;

        let overflow_pixels_left = 0;
        let overflow_pixels_right = 0;

        if (horizontal_align === Style.HorizontalAlign.Center) {
          overflow_pixels_left = overflow_pixels_right = delta / 2;
        }
        else if (horizontal_align === Style.HorizontalAlign.Right) {
          overflow_pixels_left = delta;
        }
        else {
          overflow_pixels_right = delta;
        }

        // calculate overflow into adjacent columns

        let overflow_right_column = address.column;
        let overflow_left_column = address.column;

        // cap at max. use actual max, not sheet max (which reflects the
        // extent  of spreadsheet data, but not visible cells).

        while (overflow_pixels_right > 0 && overflow_right_column < this.layout.last_column) {
          overflow_right_column++;

          const target_address = { row: address.row, column: overflow_right_column };
          const target_cell = this.model.active_sheet.CellData(target_address);
          const target_width = this.layout.ColumnWidth(overflow_right_column);
          overflow_pixels_right -= target_width;
          if (target_cell && !target_cell.type && !target_cell.calculated_type) {

            overflow_backgrounds.push({
              address: target_address,
              cell: target_cell,
              grid: new Rectangle(paint_right, 0, target_width, height),
              background: new Rectangle(paint_right - 1, 0, target_width, height - 1),
              border: new Rectangle(paint_right, 0, target_width, height),
            });

            paint_right += target_width;

            // set render data for cells we are going to overflow into;
            // that will keep them from getting painted. we only need to
            // do that on the right side.

            target_cell.render_dirty = false;
            target_cell.renderer_data = {
              overflowed: true,
            };
          }
          else {

            // we actually don't have to clip to the right, assuming
            // we're going to paint the cells anyway... right?
            // A: not necessarily, because we might not be painting the cell _now_.

            clip = true; // need to clip

            break;
          }
        }

        if (overflow_right_column > tile.last_cell.column) {
          result.tile_overflow_right = true;
        }

        while (overflow_pixels_left > 0 && overflow_left_column >= 1) {
          overflow_left_column--;

          const target_address = { row: address.row, column: overflow_left_column };
          const target_cell = this.model.active_sheet.CellData(target_address);
          const target_width = this.layout.ColumnWidth(overflow_left_column);
          overflow_pixels_left -= target_width;
          if (target_cell && !target_cell.type && !target_cell.calculated_type) {

            paint_left -= target_width;

            overflow_backgrounds.push({
              address: target_address,
              cell: target_cell,
              grid: new Rectangle(paint_left, 0, target_width, height),
              background: new Rectangle(paint_left, 0, target_width, height - 1),
              border: new Rectangle(paint_left, 0, target_width, height),
            });

          }
          else {
            clip = true; // need to clip
            break;
          }
        }

        if (overflow_left_column < tile.first_cell.column) {
          result.tile_overflow_left = true;
        }

        // push overflow onto the list

        this.overflow_areas.push({
          head: { ...address }, tile, area: new Area(
            { row: address.row, column: overflow_left_column },
            { row: address.row, column: overflow_right_column })
        });

      }
      else {

        // don't clip numbers, we are going to ### them

        clip = !is_number; // (cell.type !== ValueType.number && cell.calculated_type !== ValueType.number);

      }

    }

    let buffering = false;

    // now we can render into either the primary context or the buffer
    // context. note we don't have to clip for buffered contexts, as we're
    // going to copy.

    const original_context = context;

    if (result.tile_overflow_bottom || result.tile_overflow_left || result.tile_overflow_right) {

      buffering = true;

      result.width = paint_right - paint_left;
      result.height = height;
      result.left = paint_left;

      this.EnsureBuffer(result.width + 1, height + 1, -paint_left);

      context = this.buffer_context;
      context.font = font;

    }

    this.RenderCellBackground(!!cell.note, address, context, style, width, height);

    for (const element of overflow_backgrounds) {

      if ( element.cell.style?.fill &&
           (element.cell.style.fill.text || element.cell.style.fill.theme || element.cell.style.fill.theme === 0) &&
          !this.options.grid_over_background) {
        
        context.fillStyle = ThemeColor(this.theme, element.cell.style.fill);
        context.fillRect(element.grid.left, element.grid.top, element.grid.width, element.grid.height);
      }
      else {
        context.fillStyle = this.theme.grid_color || '';
        context.fillRect(element.grid.left, element.grid.top, element.grid.width, element.grid.height);

        // how could this ever be true, given the test above? (...)

        // if (element.cell.style && element.cell.style.background && element.cell.style.background !== 'none') {
        //  context.fillStyle = element.cell.style.background;
        // }
        // else {
        //  context.fillStyle = this.theme.grid_cell?.background || '';
        //}

        context.fillStyle = this.theme.grid_cell?.fill ? ThemeColor(this.theme, this.theme.grid_cell.fill) : '';

        context.fillRect(element.background.left, element.background.top,
          element.background.width, element.background.height);
      }

      if (element.cell.style) {

        this.RenderCellBorders(element.address, context, element.cell.style,
          element.border.left, element.border.top, element.border.width, element.border.height);
      }

    }

    const metrics = FontMetricsCache.get(style, this.layout.scale);

    // set stroke for underline

    // FIXME: color here should default to style, not ''. it's working only
    // because our default style happens to be the default color. that applies
    // to text color, background color and border color.

    context.lineWidth = 1;
    const style_text_color = style.text === 'none' ? 
        ThemeColor(this.theme, this.theme.grid_cell?.text) : 
        ThemeColor(this.theme, style.text);

    context.strokeStyle = context.fillStyle =
      text_data.format ? text_data.format :
        style_text_color || ThemeColor(this.theme, this.theme.grid_cell?.text);

    context.beginPath();

    let left = this.cell_edge_buffer;

    const line_count = text_data.single ? 1 : text_data.strings.length;
    const text_height = (line_count * metrics.block);

    // we stopped clipping initially because it was expensive -- but then
    // we were doing it on every cell. it's hard to imagine that clipping
    // is more expensive than buffering (painting to a second canvas and
    // copying). let's test clipping just in the case of unpainted overflow.

    // don't clip if buffering, it's not necessary

    clip = (clip || (text_height >= height)) && !buffering;

    if (clip) {
      context.save();
      context.beginPath();
      context.moveTo(paint_left + 1.5, 0);
      context.lineTo(paint_left + 1.5, height);
      context.lineTo(paint_right - 1.5, height);
      context.lineTo(paint_right - 1.5, 0);
      context.clip();
    }

    // path for underline. if there's no underline, it won't do anything.

    context.beginPath();

    // is this actually top, or is it bottom? it may have been top at some 
    // point but I'm pretty sure it's baseline, now (alphabetic). FIXME

    let top = Math.round(height - text_height);

    switch (style.vertical_align) {
      case Style.VerticalAlign.Top:
        top = 2;
        break;
      case Style.VerticalAlign.Middle:
        top = Math.round((height - text_height) / 2 + 2);
        break;
    }

    top += metrics.ascent + 3;

    if ((cell.type === ValueType.number || cell.calculated_type === ValueType.number) && overflow) {

      // number overflow is easy

      const count = Math.floor((width - 2 * this.cell_edge_buffer) / metrics.hash);

      let text = '';
      for (let i = 0; i < count; i++) { text += '#'; }
      const text_width = context.measureText(text).width;

      if (horizontal_align === Style.HorizontalAlign.Center) {
        left = Math.round((width - text_width) / 2);
      }
      else if (horizontal_align === Style.HorizontalAlign.Right) {
        left = width - this.cell_edge_buffer - text_width;
      }

      context.fillText(text, left, top);
      
    }
    else if (text_data.single) { // && 17 > 20) {

      // in this case text_part.width is composite

      // why are single and multiple lines in different paths?
      // wouldn't single be the same as 1-entry multiple? is this
      // an optimization? (...)

      // tested with above condition and seems to work exactly the 
      // same... and saves duplication... TODO


      if (horizontal_align === Style.HorizontalAlign.Center) {
        left = Math.round((width - text_data.width) / 2);
      }
      else if (horizontal_align === Style.HorizontalAlign.Right) {
        left = width - this.cell_edge_buffer - text_data.width;
      }

      // let path_started = false;
      const underline_y = top + metrics.block - 3.5 - metrics.ascent - 3; // calc? ...
      const strike_y = Math.round(top  - metrics.ascent / 2) + 0.5;

      // we want a single underline, possibly spanning hidden elements,
      // but not starting or stopping on a hidden element (usually invisible
      // parentheses).

      for (const part of text_data.strings) {
        if (!part.hidden) {
          context.fillText(part.text, left, top);
          if (style.font_underline) {
            // if (!path_started) {
            //  path_started = true;
            context.moveTo(left, underline_y);
            //}
            context.lineTo(left + part.width, underline_y);
          }
          if (style.font_strike) {
            context.moveTo(left, strike_y);
            context.lineTo(left + part.width, strike_y);
          }
        }

        if (preserve_layout_info) {
          part.left = left;
          part.top = top - metrics.block;
          part.height = metrics.block;
        }

        left += part.width;
      }

    }
    else {

      for (const part of text_data.strings) {

        // here we justify based on part, each line might have different width

        if (horizontal_align === Style.HorizontalAlign.Center) {
          left = Math.round((width - part.width) / 2);
        }
        else if (horizontal_align === Style.HorizontalAlign.Right) {
          left = width - this.cell_edge_buffer - part.width;
        }

        if (style.font_underline) {
          const underline_y = top + metrics.block - 3.5 - metrics.ascent - 3;
          context.moveTo(left, underline_y);
          context.lineTo(left + part.width, underline_y);
        }
        
        if (style.font_strike) {
          const strike_y = Math.round(top  - metrics.ascent / 2) + 1.5;
          context.moveTo(left, strike_y);
          context.lineTo(left + part.width, strike_y);
        }

        context.fillText(part.text, left, top);

        if (preserve_layout_info) {
          part.left = left;
          part.top = top - metrics.block;
          part.height = metrics.block;
        }

        top += metrics.block;
      }

    }

    context.stroke();

    if (clip) {
      context.restore();
    }
    else if (buffering) {
      const scale = this.layout.dpr;
      original_context.drawImage(this.buffer_canvas,
        0, 0, (result.width || 0) * scale,
        height * scale, paint_left, 0, result.width || 0, height);
    }

    return result;

  }

}
