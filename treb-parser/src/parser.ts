
import {
  ExpressionUnit,
  UnitAddress,
  UnitIdentifier,
  UnitOperator,
  UnitRange,
  UnitArray,
  UnitUnary,
  DependencyList,
  ParseResult,
  ArgumentSeparatorType,
  DecimalMarkType,
  UnitLiteral,
} from './parser-types';

interface PrecedenceList {
  [index: string]: number;
}

/**
 * regex determines if a sheet name requires quotes. centralizing
 * this to simplify maintenance and reduce overlap/errors
 */
export const QuotedSheetNameRegex = /[\s-+=<>!()]/;

/**
 * similarly, illegal sheet name. we don't actually handle this in
 * the parser, but it seems like a reasonable place to keep this
 * definition.
 */
export const IllegalSheetNameRegex = /['*\\]/;

const DOUBLE_QUOTE = 0x22; // '"'.charCodeAt(0);
const SINGLE_QUOTE = 0x27; // `'`.charCodeAt(0);

const NON_BREAKING_SPACE = 0xa0;
const SPACE = 0x20;
const TAB = 0x09;
const CR = 0x0a;
const LF = 0x0d;

const ZERO = 0x30;
const NINE = 0x39;
const PERIOD = 0x2e;

const PLUS = 0x2b;
const MINUS = 0x2d;

const OPEN_PAREN = 0x28;
const CLOSE_PAREN = 0x29;

const COMMA = 0x2c;
const PERCENT = 0x25;

const UNDERSCORE = 0x5f;
const DOLLAR_SIGN = 0x24;

const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;

const EXCLAMATION_MARK = 0x21;
// const COLON = 0x3a; // became an operator
const SEMICOLON = 0x3b;

const UC_A = 0x41;
const LC_A = 0x61;
const UC_E = 0x45;
const LC_E = 0x65;
const UC_Z = 0x5a;
const LC_Z = 0x7a;

const LC_I = 0x69;
const LC_J = 0x6a;

const ACCENTED_RANGE_START = 192;
const ACCENTED_RANGE_END = 312;

/**
 * precedence map
 */
const binary_operators_precendence: PrecedenceList = {
  '==': 6,
  '!=': 6, // FIXME: we should not support these (legacy)
  '<>': 6,
  '=': 6, // these are the appropriate equality operators for SL
  '<': 7,
  '>': 7,
  '<=': 7,
  '>=': 7,
  '+': 9,
  '-': 9,
  '&': 9,
  '*': 10,
  '/': 10,
  '^': 11, // highest math op
  ':': 13, // range operator
};

/**
 * binary ops are sorted by length so we can compare long ops first
 */
const binary_operators = Object.keys(binary_operators_precendence).sort(
  (a, b) => b.length - a.length,
);

/**
 * unary operators. atm we have no precedence issues, unary operators
 * always have absolute precedence. (for numbers, these are properly part
 * of the number, but consider `=-SUM(1,2)` -- this is an operator).
 */
const unary_operators: PrecedenceList = { '-': 100, '+': 100 };

/**
 * parser for spreadsheet language.
 *
 * FIXME: this is stateless, think about exporting a singleton.
 *
 * (there is internal state, but it's only used during a Parse() call,
 * which runs synchronously). one benefit of using a singleton would be
 * consistency in decimal mark, we'd only have to set once.
 *
 * FIXME: split rendering into a separate class? would be a little cleaner.
 */
export class Parser {

  /** flag to enable/disable */
  public support_complex_numbers = true; // false;

  /**
   * argument separator. this can be changed prior to parsing/rendering.
   * FIXME: use an accessor to ensure type, outside of ts?
   */
  public argument_separator = ArgumentSeparatorType.Comma;

  /**
   * decimal mark. this can be changed prior to parsing/rendering.
   * FIXME: use an accessor to ensure type, outside of ts?
   */
  public decimal_mark = DecimalMarkType.Period;

  /**
   * internal argument separator, as a number. this is set internally on
   * parse call, following the argument_separator value.
   */
  protected argument_separator_char = COMMA;

  /**
   * internal decimal mark, as a number.
   */
  protected decimal_mark_char = PERIOD;

  /**
   * imaginary number value. this is "i", except for those EE weirdos who use "j".
   */
  protected imaginary_char: 0x69|0x6A = LC_I;

  /**
   * imaginary number as text for matching
   */
  protected imaginary_number: 'i'|'j' = 'i';

  /**
   * internal counter for incrementing IDs
   */
  protected id_counter = 0;

  protected expression = '';
  protected data: number[] = [];
  protected index = 0;
  protected length = 0;

  /** success flag */
  protected valid = true;

  /** rolling error state */
  protected error_position: number | undefined;

  /** rolling error state */
  protected error: string | undefined;

  protected dependencies: DependencyList = {
    addresses: {},
    ranges: {},
  };

  // referenced addresses -- used to merge ranges/addresses, although I'm
  // not sure that's actually all that useful
  protected address_refcount: { [index: string]: number } = {};

  /**
   * full list of referenced addresses and ranges. we're adding this
   * to support highlighting, for which we need multiple instances
   * of a single address. the original dep list was used for graph dependencies,
   * so we compressed the list.
   *
   * FIXME: use a single list, i.e. something like
   *
   *   address -> [instance, instance]
   *
   * because that's a big API change it's going to have to wait. for now,
   * use a second list.
   *
   * UPDATE: adding (otherwise unused) tokens, which could be named ranges.
   * in the future we may pass in a list of names at parse time, and resolve
   * them; for now we are just listing names.
   */
  protected full_reference_list: Array<UnitAddress | UnitRange | UnitIdentifier> = [];

  /**
   * recursive tree walk.
   *
   * @param func function called on each node. for nodes that have children
   * (operations, calls, groups) return false to skip the subtree, or true to
   * traverse.
   */
  public Walk(unit: ExpressionUnit, func: (unit: ExpressionUnit) => boolean): void {
    switch (unit.type) {
      case 'address':
      case 'missing':
      case 'literal':
      case 'complex':
      case 'identifier':
      case 'operator':
        func(unit);
        return;

      case 'range':
        if (func(unit)) {
          this.Walk(unit.start, func);
          this.Walk(unit.end, func);
        }
        return;

      case 'binary':
        if (func(unit)) {
          this.Walk(unit.left, func);
          this.Walk(unit.right, func);
        }
        return;

      case 'unary':
        if (func(unit)) {
          this.Walk(unit.operand, func);
        }
        return;

      case 'group':
        if (func(unit)) {
          unit.elements.forEach((element) => this.Walk(element, func));
        }
        return;

      case 'call':
        if (func(unit)) {
          unit.args.forEach((arg) => this.Walk(arg, func));
        }
    }
  }

  /** utility: transpose array */
  public Transpose(arr: Array < Array <string|boolean|number|undefined> >): Array < Array <string|boolean|number|undefined> > {

    const m = arr.length;
    const transposed: Array < Array <string|boolean|number|undefined> > = [];
    let n = 0;

    for (let i = 0; i < m; i++){ 
      if (Array.isArray(arr[i])) {
        n = Math.max(n, arr[i].length);
      }
    }

    for (let i = 0; i < n; i++) {
      transposed[i] = [];
      for (let j = 0; j < m; j++) {
        transposed[i][j] = arr[j][i];
      }
    }

    return transposed;
  }

  /**
   * renders the passed expression as a string.
   * @param unit base expression
   * @param offset offset for addresses, used to offset relative addresses
   * (and ranges). this is for copy-and-paste or move operations.
   * @param missing string to represent missing values (can be '', for functions)
   */
  public Render(
    unit: ExpressionUnit,
    offset: { rows: number; columns: number } = { rows: 0, columns: 0 },
    missing = '(missing)',
    convert_decimal?: DecimalMarkType,
    convert_argument_separator?: ArgumentSeparatorType,
    convert_imaginary_number?: 'i'|'j',
  ): string {
    // use default separator, unless we're explicitly converting.

    let separator = this.argument_separator + ' ';
    if (convert_argument_separator === ArgumentSeparatorType.Comma) {
      separator = ', ';
    }
    else if (convert_argument_separator === ArgumentSeparatorType.Semicolon) {
      separator = '; ';
    }

    let imaginary_character = this.imaginary_number;
    if (convert_imaginary_number) {
      imaginary_character = convert_imaginary_number;
    }

    // this is only used if we're converting.

    const decimal = convert_decimal === DecimalMarkType.Comma ? ',' : '.';
    const decimal_rex =
      this.decimal_mark === DecimalMarkType.Comma ? /,/ : /\./;

    switch (unit.type) {
      case 'address':
        return this.AddressLabel(unit, offset);

      case 'range':
        return (
          this.AddressLabel(unit.start, offset) +
          ':' +
          this.AddressLabel(unit.end, offset)
        );

      case 'missing':
        return missing;

      case 'array':

        // we have to transpose because we're column-major but the 
        // format is row-major

        return '{' +
          this.Transpose(unit.values).map((row) => row.map((value) => {
            if (typeof value === 'string') {
              return '"' + value + '"';
            }
            return value;
          }).join(', ')).join('; ') + '}';

      case 'binary':
        return (
          this.Render(
            unit.left,
            offset,
            missing,
            convert_decimal,
            convert_argument_separator,
          ) +
          ' ' +
          unit.operator +
          ' ' +
          this.Render(
            unit.right,
            offset,
            missing,
            convert_decimal,
            convert_argument_separator,
          )
        );

      case 'unary':
        return (
          unit.operator +
          this.Render(
            unit.operand,
            offset,
            missing,
            convert_decimal,
            convert_argument_separator,
          )
        );

      case 'complex':
        return `${unit.real||0}${unit.imaginary < 0 ? '' : '+'}${unit.imaginary}${imaginary_character}`;
      
      case 'literal':
        if (typeof unit.value === 'string') {

          // escape any quotation marks in string
          return '"' + unit.value.replace(/"/g, '""') + '"';
        }
        else if (convert_decimal && typeof unit.value === 'number') {
          if (unit.text) {
            // here we want to translate the literal typed-in value.
            // users can type in a decimal point and possibly grouping.
            // if we are converting from dot to comma, we need to make
            // sure to remove any existing commas. for the time being
            // we will just remove them.

            // what about the alternate case? in that case, we're not allowing
            // users to type in groupings (I think), so we can skip that part.

            // ACTUALLY, we don't allow grouping at all. we normalize it
            // if you type in a number. why? consider functions, grouping
            // looks like parameter separation. so no.

            let text = unit.text;
            if (
              convert_decimal === DecimalMarkType.Comma &&
              this.decimal_mark === DecimalMarkType.Period
            ) {
              text = text.replace(/,/g, ''); // remove grouping
            }
            return text.replace(decimal_rex, decimal);
          }
          else {
            // this always works because this function is guaranteed
            // to return value in dot-decimal format without separators.

            return unit.value.toString().replace(/\./, decimal);
          }
        }
        else if (unit.text) return unit.text;
        return unit.value.toString();

      case 'identifier':
        return unit.name;

      case 'operator':
        return '[' + unit.operator + ']'; // this should be invalid output

      case 'group':
        if (unit.explicit) {
          return (
            '(' +
            unit.elements
              .map((x) =>
                this.Render(
                  x,
                  offset,
                  missing,
                  convert_decimal,
                  convert_argument_separator,
                ),
              )
              .join(separator) +
            ')'
          );
        }
        else {
          return unit.elements
            .map((x) =>
              this.Render(
                x,
                offset,
                missing,
                convert_decimal,
                convert_argument_separator,
              ),
            )
            .join(separator);
        }

      case 'call':
        return (
          unit.name +
          '(' +
          unit.args
            .map((x) =>
              this.Render(
                x,
                offset,
                missing,
                convert_decimal,
                convert_argument_separator,
              ),
            )
            .join(separator) +
          ')'
        );
    }

    return '??';
  }

  /**
   * parses expression and returns the root of the parse tree, plus a
   * list of dependencies (addresses and ranges) found in the expression.
   *
   * NOTE that in the new address parsing structure, we will overlap ranges
   * and addresses (range corners). this is OK because ranges are mapped
   * to individual address dependencies. it's just sloppy (FIXME: refcount?)
   */
  public Parse(expression: string): ParseResult {

    // normalize
    expression = expression.trim();

    // remove leading =
    if (expression[0] === '=') {
      expression = expression.substr(1).trim();
    }

    this.expression = expression;
    this.data = [];
    this.length = expression.length;
    this.index = 0;
    this.valid = true;
    this.error_position = undefined;
    this.error = undefined;
    this.dependencies.addresses = {};
    this.dependencies.ranges = {};
    this.address_refcount = {};
    this.full_reference_list = [];

    // reset ID
    this.id_counter = 0;

    // set separator
    switch (this.argument_separator) {
      case ArgumentSeparatorType.Semicolon:
        this.argument_separator_char = SEMICOLON;
        break;
      default:
        this.argument_separator_char = COMMA;
        break;
    }

    // and decimal mark
    switch (this.decimal_mark) {
      case DecimalMarkType.Comma:
        this.decimal_mark_char = COMMA;
        break;
      default:
        this.decimal_mark_char = PERIOD;
        break;
    }

    // NOTE on this function: charCodeAt returns UTF-16. codePointAt returns
    // unicode. length returns UTF-16 length. any characters that are not
    // representable as a single character in UTF-16 will be 'the first unit
    // of a surrogate pair...' and so on.
    //
    // we want UTF-16, not unicode. for the parser itself, we are only really
    // looking for ASCII, so it's not material. for anything else, if we
    // construct strings from the original data we want to map the UTF-16,
    // otherwise we will construct the string incorrectly. this applies to
    // strings, function names, and anything else.
    //
    // which is all a long way of saying, don't be tempted to replace this
    // with codePointAt.

    for (let i = 0; i < this.length; i++) {
      this.data[i] = expression.charCodeAt(i);
    }

    const expr = this.ParseGeneric();

    // remove extraneous addresses

    // NOTE: we still may have duplicates that have different absolute/relative
    // modifiers, e.g. C3 and $C$3 (and $C3 and C$3). not sure what we should
    // do about that, since some consumers may consider these different -- we
    // need to establish a contract about this

    const addresses: { [index: string]: UnitAddress } = {};
    for (const key of Object.keys(this.dependencies.addresses)) {
      if (this.address_refcount[key]) {
        addresses[key] = this.dependencies.addresses[key];
      }
    }
    this.dependencies.addresses = addresses;

    return {
      expression: expr || undefined,
      valid: this.valid,
      error: this.error,
      error_position: this.error_position,
      dependencies: this.dependencies,
      separator: this.argument_separator,
      decimal_mark: this.decimal_mark,
      full_reference_list: this.full_reference_list.slice(0),
    };
  }

  /** generates column label ("A") from column index (0-based) */
  protected ColumnLabel(column: number): string {
    if (column === Infinity) { return ''; }
    let s = String.fromCharCode(65 + (column % 26));
    while (column > 25) {
      column = Math.floor(column / 26) - 1;
      s = String.fromCharCode(65 + (column % 26)) + s;
    }
    return s;
  }

  /** generates address label ("C3") from address (0-based) */
  protected AddressLabel(
    address: UnitAddress,
    offset: { rows: number; columns: number },
  ): string {
    let column = address.column;
    if (!address.absolute_column && address.column !== Infinity) column += offset.columns;

    let row = address.row;
    if (!address.absolute_row && address.row !== Infinity) row += offset.rows;

    if (row < 0 || column < 0 || (row === Infinity && column === Infinity)) return '#REF';

    let label = '';
    if (address.sheet) {
      label = (QuotedSheetNameRegex.test(address.sheet) ?
        '\'' + address.sheet + '\'' : address.sheet) + '!';
    }

    if (row === Infinity) {
      return label + 
        (address.absolute_column ? '$' : '') +
        this.ColumnLabel(column);
    }

    if (column === Infinity) {
      return label + 
        (address.absolute_row ? '$' : '') +
        (row + 1)
    }

    return (
      label +
      (address.absolute_column ? '$' : '') +
      this.ColumnLabel(column) +
      (address.absolute_row ? '$' : '') +
      (row + 1)
    );
  }

  /**
   * base parse routine; may recurse inside parens (either as grouped
   * operations or in function arguments).
   *
   * @param exit exit on specific characters
   */
  protected ParseGeneric(exit: number[] = [0]): ExpressionUnit | null {
    let stream: ExpressionUnit[] = [];

    for (; this.index < this.length;) {
      const unit = this.ParseNext(stream.length === 0);
      if (typeof unit === 'number') {

        if (exit.some((test) => unit === test)) {
          break;
        }
        else if (unit === OPEN_PAREN) {

          // note that function calls are handled elsewhere,
          // so we only have to worry about grouping. parse
          // up to the closing paren...

          this.index++; // open paren
          const group = this.ParseGeneric([CLOSE_PAREN]);
          this.index++; // close paren

          // and wrap up in a group element to prevent reordering.
          // flag indicates that this is a user grouping, not ours

          // skip nulls

          if (group) {
            stream.push({
              type: 'group',
              id: this.id_counter++,
              elements: [group],
              explicit: true,
            });
          }
        }
        else {
          // this can probably move to PNext? except for the test
          // on looking for a binary operator? (...)

          const operator = this.ConsumeOperator();
          if (operator) stream.push(operator);
          else {
            this.error = `unexpected character [1]: ${String.fromCharCode(unit)}, ${unit}`;
            this.valid = false;
            this.index++;
          }
        }
      }
      else {
        stream.push(unit);
      }
    }

    // why do we build ranges after doing reordering? since ranges
    // have the highest precedence (after complex numbers), why not
    // just run through them now? also we could merge the complex
    // composition (or not, since that's optional)

    // ...

    // OK, doing that now (testing). a side benefit is that this solves
    // one of the problems we had with complex numbers, mismatching naked
    // column identifiers like I:J. if we do ranges first we will not run
    // into that problem.

    if (stream.length) {
      stream = this.BinaryToRange2(stream);
    }

    // ok now complex

    if (this.support_complex_numbers && stream.length) {
      stream = this.CompositeComplexNumbers(stream);
    }

    // console.info("STREAM\n", stream, "\n\n");

    if (stream.length === 0) return null;
    if (stream.length === 1) return stream[0];

    // fix ordering of binary operations based on precedence; also
    // convert and validate ranges

    // return this.BinaryToRange(this.ArrangeUnits(stream));
    return this.ArrangeUnits(stream);
  }

  /**
   * we parse real and imaginary numbers, but we want the output to contain
   * complex numbers. this stage reads a stream of basic units (before we 
   * build binary or unary blocks) and translates complex numbers.
   * 
   * there are three things we're looking for (three-and-a-half):
   *
   * (1) a naked imaginary number, like 3i. turn this into a complex number
   *     with the same value.
   *
   * (2) a token "i" (or "j", depending). if we support complex numbers then
   *     treat this as 1i, turn it into a complex number.
   *
   * (3) a composite complex number that looks like (real)(+/-)(imaginary).
   *     turn that into a complex number. 
   * 
   * (+) we may also see something like 3.2+i, where "i" will be represented 
   *     as an identifier (as in (2) above). in that case treat it as +/- 1i.
   * 
   * 
   * @param stream 
   */
  protected CompositeComplexNumbers(stream: ExpressionUnit[]): ExpressionUnit[] {

    let result: ExpressionUnit[] = [];

    for (let i = 0; i < stream.length; i++) {
      const a = stream[i];
      const b = stream[i + 1];
      const c = stream[i + 2];

      //
      // handle case 3 (and 3 1/2) first because it will consume 3 tokens
      //

      if (a.type === 'literal' 
            && typeof a.value === 'number' 
            && b && c 
            && b.type === 'operator'
            && (b.operator === '+' || b.operator === '-')
            && (c.type === 'imaginary' || (c.type === 'identifier' && c.name === this.imaginary_number))) {

        // let text = a.text + b.operator;
        let imaginary_value = 1;

        // binary-to-range has a better mechanism for text, it uses the 
        // positions as indexes into the original expression (updated)

        let text = '';

        if (c.type === 'imaginary') {
          // text += (c.text || '');
          imaginary_value = c.value;
          text = this.expression.substring(a.position, b.position + (c.text?.length || 0));
        }
        else {
          // text += 'i';
          text = this.expression.substring(a.position, b.position + c.name.length);
        }

        if (b.operator === '-') {
          imaginary_value = -imaginary_value;
        }

        result.push({
          type: 'complex',
          position: a.position,
          text: text, 
          id: a.id,
          imaginary: imaginary_value,
          real: a.value,
        });

        // jump
        i += 2;
      }
      else if (a.type === 'imaginary') {

        // this is case 1

        // convert to complex
        result.push({
          type: 'complex',
          position: a.position,
          text: a.text, 
          id: a.id,
          imaginary: a.value,
          real: 0,
        });

      }
      else if (a.type === 'identifier' && a.name === this.imaginary_number) {

        // this is case 2, something that looks like an identifier.
        //
        // FIXME: this will break column range notation like i:i.
        // perhaps we should do the range operation first.

        // call this 1i
        result.push({
          type: 'complex',
          position: a.position,
          text: a.name, 
          id: a.id,
          imaginary: 1,
          real: 0,
        });

      }
      else {
        result.push(a);
      }
    }

    return result;

  }

  /**
   * helper function, @see BinaryToRange
   * @param unit 
   * @returns 
   */
  protected UnitToAddress(unit: UnitLiteral|UnitIdentifier): UnitAddress|undefined {

    // console.info("U2", unit);

    // for literals, only numbers are valid
    if (unit.type === 'literal') {
      if (typeof unit.value === 'number' && unit.value > 0 && !/\./.test(unit.text||'')) {
        return {
          type: 'address',
          position: unit.position,
          label: unit.value.toString(),
          row: unit.value - 1,
          id: this.id_counter++,
          column: Infinity,
        };
      }
    }
    else {

      // UPDATE: sheet names... we may actually need a subparser for this?
      // or can we do it with a regex? (...)

      let sheet: string|undefined;
      let name = unit.name;

      const tokens = name.split('!');
      if (tokens.length > 1) {
        sheet = tokens.slice(0, tokens.length - 1).join('!');
        name = name.substr(sheet.length + 1);
        if (sheet[0] === '\'') {
          if (sheet.length > 1 && sheet[sheet.length - 1] === '\'') {
            sheet = sheet.substr(1, sheet.length - 2);
          }
          else {
            // console.info('mismatched single quote');
            return undefined;
          }
        }
      }

      const absolute = name[0] === '$';
      name = (absolute ? name.substr(1) : name).toUpperCase();
      const as_number = Number(name);

      // if it looks like a number, consider it a number and then be strict
      if (!isNaN(as_number)) {
        if (as_number > 0 && as_number !== Infinity && !/\./.test(name)) {
          return {
            type: 'address',
            position: unit.position,
            absolute_row: absolute,
            label: unit.name,
            row: as_number - 1,
            id: this.id_counter++,
            column: Infinity,
            sheet,
          };
        }
      }
      else if (/[A-Z]{1,3}/.test(name)) {
        
        let column = -1; // clever

        for (let i = 0; i < name.length; i++) {
          const char = name[i].charCodeAt(0);
          column = 26 * (1 + column) + (char - UC_A);
        }

        return {
          type: 'address',
          position: unit.position,
          absolute_column: absolute,
          label: unit.name,
          column,
          id: this.id_counter++,
          row: Infinity,
          sheet,
        }

      }

    }

    return undefined;
  }

  /**
   * rewrite of binary to range. this version operates on the initial stream,
   * which should be OK because range has the highest precedence so we would
   * never reorder a range.
   * 
   * ACTUALLY this will break in the case of 
   * 
   * -15:16 
   * 
   * (I think that's the only case). we can fix that though. this should
   * not impact the case of `2-15:16`, because in that case the - will look
   * like an operator and not part of the number. the same goes for a leading
   * `+` which will get dropped implicitly but has no effect (we might want
   * to preserve it for consistency though).
   * 
   * NOTE: that error existed in the old version, too, and this way is perhaps
   * better for fixing it. we should merge this into main.
   * 
   * 
   * old version comments:
   * ---
   * 
   * converts binary operations with a colon operator to ranges. this also
   * validates that there are no colon operations with non-address operands
   * (which is why it's called after precendence reordering; colon has the
   * highest preference). recursive only over binary ops AND unary ops.
   * 
   * NOTE: there are other legal arguments to a colon operator. specifically:
   * 
   * (1) two numbers, in either order
   *
   * 15:16
   * 16:16
   * 16:15
   *
   * (2) with one or both optionally having a $
   *
   * 15:$16
   * $16:$16
   *
   * (3) two column identifiers, in either order
   * 
   * A:F
   * B:A
   *
   * (4) and the same with $
   *
   * $A:F
   * $A:$F
   * 
   * because none of these are legal in any other context, we leave the 
   * default treatment of them UNLESS they are arguments to the colon 
   * operator, in which case we will grab them. that does mean we parse
   * them twice, but (...)
   * 
   * FIXME: will need some updated to rendering these, we don't have any
   * handler for rendering infinity
   */
  protected BinaryToRange2(stream: ExpressionUnit[]): ExpressionUnit[] {
    const result: ExpressionUnit[] = [];

    for (let i = 0; i < stream.length; i++) {

      const a = stream[i];
      const b = stream[i + 1];
      const c = stream[i + 2];

      let range: UnitRange|undefined;
      let label = '';

      let negative: UnitOperator|undefined; // this is a fix for the error case `-14:15`, see below

      if (a && b && c && b.type === 'operator' && b.operator === ':') {

        if (a.type === 'address' && c.type === 'address') {

          // construct a label using the full text. there's a possibility,
          // I suppose, that there are spaces (this should probably not be
          // legal). this is a canonical label, though (generated)

          // it might be better to let this slip, or treat it as an error
          // and force a correction... not sure (TODO/FIXME)

          const start_index = a.position + a.label.length;
          const end_index = c.position;

          range = {
            type: 'range',
            id: this.id_counter++,
            position: a.position,
            start: a,
            end: c,
            label:
              a.label +
              this.expression.substring(start_index, end_index) +
              c.label,
          };

          label = range.start.label + ':' + range.end.label;

          this.address_refcount[range.start.label]--;
          this.address_refcount[range.end.label]--;

          // remove entries from the list for start, stop
          const positions = [a.position, c.position];
          this.full_reference_list = this.full_reference_list.filter((test) => {
            return (
              test.position !== positions[0] && test.position !== positions[1]
            );
          });

        }
        else if ((a.type === 'literal' || a.type === 'identifier')
                && (c.type === 'literal' || c.type === 'identifier')) {

          // see if we can plausibly interpret both of these as rows or columns

          // this is a fix for the case of `-14:15`, which is kind of a rare
          // case but could happen. in that case we need to invert the first number,
          // so it parses as an address properly, and also insert a "-" which
          // should be treated as a unary operator.

          // if this happens, the first part must look like a negative number,
          // e.g. -10, so there are no leading spaces or intervening spaces
          // between the - and the value. therefore...

          let left = this.UnitToAddress(a);
          if (!left && a.type === 'literal' && typeof a.value === 'number' && a.value < 0) {
            const test = {
              ...a,
              text: (a.text || '').replace(/^-/, ''), // <- ...sign always in position 0
              position: a.position + 1, // <- ...advance 1
              value: -a.value, // <- ...invert value
            };
            left = this.UnitToAddress(test);

            if (left) {

              // if that worked, we need to insert an operator into the
              // stream to reflect the - sign. we use the original position.

              negative = {
                type: 'operator',
                operator: '-',
                position: a.position,
                id: this.id_counter++,
              }
            }

          }

          const right = this.UnitToAddress(c);

          // and they need to match

          if (left && right
              && ((left.column === Infinity && right.column === Infinity)
                  || (left.row === Infinity && right.row === Infinity))) {

            label = left.label + ':' + right.label;

            // we don't support out-of-order ranges, so we should correct.
            // they just won't work otherwise. (TODO/FIXME)
          
            range = {
              type: 'range',
              id: this.id_counter++,
              position: left.position,
              start: left,
              end: right,
              label,
            };

          }
        }

      }

      if (range) {

        if (negative) {
          result.push(negative);
        }

        result.push(range);
        this.dependencies.ranges[label] = range;
        this.full_reference_list.push(range);

        // skip
        i += 2;
      }
      else {
        result.push(a);
      }

    }

    return result;
  }

  /**
   * converts binary operations with a colon operator to ranges. this also
   * validates that there are no colon operations with non-address operands
   * (which is why it's called after precendence reordering; colon has the
   * highest preference). recursive only over binary ops AND unary ops.
   * 
   * NOTE: there are other legal arguments to a colon operator. specifically:
   * 
   * (1) two numbers, in either order
   *
   * 15:16
   * 16:16
   * 16:15
   *
   * (2) with one or both optionally having a $
   *
   * 15:$16
   * $16:$16
   *
   * (3) two column identifiers, in either order
   * 
   * A:F
   * B:A
   *
   * (4) and the same with $
   *
   * $A:F
   * $A:$F
   * 
   * because none of these are legal in any other context, we leave the 
   * default treatment of them UNLESS they are arguments to the colon 
   * operator, in which case we will grab them. that does mean we parse
   * them twice, but (...)
   * 
   * FIXME: will need some updated to rendering these, we don't have any
   * handler for rendering infinity
   */
  protected BinaryToRangeX(unit: ExpressionUnit): ExpressionUnit {
    if (unit.type === 'binary') {
      if (unit.operator === ':') {

        let range: UnitRange|undefined;
        let label = '';

        if (unit.left.type === 'address' && unit.right.type === 'address') {
          // construct a label using the full text. there's a possibility,
          // I suppose, that there are spaces (this should probably not be
          // legal). this is a canonical label, though (generated)

          // it might be better to let this slip, or treat it as an error
          // and force a correction... not sure (TODO/FIXME)

          const start_index = unit.left.position + unit.left.label.length;
          const end_index = unit.right.position;

          range = {
            type: 'range',
            id: this.id_counter++,
            position: unit.left.position,
            start: unit.left,
            end: unit.right,
            label:
              unit.left.label +
              this.expression.substring(start_index, end_index) +
              unit.right.label,
          };

          label = range.start.label + ':' + range.end.label;

          this.address_refcount[range.start.label]--;
          this.address_refcount[range.end.label]--;

          // remove entries from the list for start, stop
          const positions = [unit.left.position, unit.right.position];
          this.full_reference_list = this.full_reference_list.filter((test) => {
            return (
              test.position !== positions[0] && test.position !== positions[1]
            );
          });

        }
        else if ((unit.left.type === 'literal' || unit.left.type === 'identifier')
                && (unit.right.type === 'literal' || unit.right.type === 'identifier')) {

          // see if we can plausibly interpret both of these as rows or columns

          const left = this.UnitToAddress(unit.left);
          const right = this.UnitToAddress(unit.right);

          // and they need to match

          if (left && right
              && ((left.column === Infinity && right.column === Infinity)
                  || (left.row === Infinity && right.row === Infinity))) {

            label = left.label + ':' + right.label;

            // we don't support out-of-order ranges, so we should correct.
            // they just won't work otherwise. (TODO/FIXME)
           
            range = {
              type: 'range',
              id: this.id_counter++,
              position: unit.left.position,
              start: left,
              end: right,
              label,
            };

          }
                    
        }

        /*
        else if ( unit.left.type === 'literal' 
                  && unit.right.type === 'literal' 
                  && typeof unit.left.value === 'number' 
                  && typeof unit.right.value === 'number') {

          // technically we don't want to support any number that has
          // a decimal place, but I'm not sure we have a useful way of
          // measuring that... could look at the original text?

          if (unit.left.value > 0 
              && unit.right.value > 0
              && !/\./.test(unit.left.text||'')
              && !/\./.test(unit.right.text||'')
              ) {

            label = unit.left.value.toString() + ':' + unit.right.value.toString();

            console.info('m2:', label);

            const left: UnitAddress = {
              type: 'address',
              position: unit.left.position,
              label: unit.left.value.toString(),
              row: unit.left.value - 1,
              id: this.id_counter++,
              column: Infinity,
            };

            const right: UnitAddress = {
              type: 'address',
              position: unit.right.position,
              label: unit.right.value.toString(),
              row: unit.right.value - 1,
              id: this.id_counter++,
              column: Infinity,
            };

            range = {
              type: 'range',
              id: this.id_counter++,
              position: unit.left.position,
              start: left,
              end: right,
              label,
            };

          }
          
        }
        */

        if (range) {

          this.dependencies.ranges[label] = range;

          // and add the range
          this.full_reference_list.push(range);

          return range;

        }
        else {
          this.error = `unexpected character: :`;
          this.valid = false;
          // console.info('xx', unit);
        }

      }

      // recurse

      unit.left = this.BinaryToRangeX(unit.left);
      unit.right = this.BinaryToRangeX(unit.right);
    }

    // this should no longer be required, because we explicitly check
    // when we construct the unary operations...

    // else if (unit.type === 'unary') {
    //   unit.operand = this.BinaryToRange(unit.operand);
    // }

    return unit;
  }

  /**
   * reorders operations for precendence
   */
  protected ArrangeUnits(stream: ExpressionUnit[]): ExpressionUnit {
    // probably should not happen
    if (stream.length === 0) return { type: 'missing', id: this.id_counter++ };

    // this is probably already covered
    if (stream.length === 1) return stream[0];

    const stack: ExpressionUnit[] = [];

    // work left-to-right (implied precendence), unless there
    // is actual precendence. spreadsheet language only supports
    // binary operators, so we always expect unit - operator - unit
    //
    // UPDATE: that's incorrect. SL supports unary + and - operators.
    // which makes this more complicated.
    //
    // we explicitly support unfinished expressions for the first pass
    // to build dependencies, but if they're invalid the resulting
    // parse tree isn't expected to be correct. in that case we
    // generally will pass back a bag of parts, with a flag set.

    for (let index = 0; index < stream.length; index++) {
      let element = stream[index];

      // given that we need to support unary operators, the logic needs
      // to be a little different. operators are OK at any position, provided
      // we can construct either a unary or binary operation.

      if (element.type === 'operator') {
        if (stack.length === 0 || stack[stack.length - 1].type === 'operator') {
          // valid if unary operator and we can construct a unary operation.
          // in this case we do it with recursion.

          if (unary_operators[element.operator]) {

            // MARK X

            // const right = this.BinaryToRange(
            //  this.ArrangeUnits(stream.slice(index + 1)),
            //);

            const right = this.ArrangeUnits(stream.slice(index + 1));

            // this ensures we return the highest-level group, even if we recurse
            if (!this.valid) {
              return {
                type: 'group',
                id: this.id_counter++,
                elements: stream,
                explicit: false,
              };
            }

            // if it succeeded, then we need to apply the unary operator to
            // the result, or if it's a binary operation, to the left-hand side
            // (because we have precedence) -- unless it's a range [this is now
            // handled above]

            if (right.type === 'binary') {
              right.left = {
                type: 'unary',
                id: this.id_counter++,
                operator: element.operator,
                operand: right.left,
                position: element.position,
              } as UnitUnary;
              element = right;
            }
            else {
              // create a unary operation which will replace the element
              element = {
                type: 'unary',
                id: this.id_counter++,
                operator: element.operator,
                operand: right,
                position: element.position,
              } as UnitUnary;
            }

            // end loop after this pass, because the recurse consumes everything else
            index = stream.length;
          }
          else {
            this.error = `unexpected character [2]: ${element.operator}`;
            this.error_position = element.position;
            this.valid = false;
            return {
              type: 'group',
              id: this.id_counter++,
              elements: stream,
              explicit: false,
            };
          }
        }
        else {
          stack.push(element);
          continue;
        }
      }

      if (stack.length < 2) {
        stack.push(element);
      }
      else if (stack[stack.length - 1].type === 'operator') {
        const left = stack[stack.length - 2];
        const operator_unit = stack[stack.length - 1] as UnitOperator;
        const operator = operator_unit.operator;

        // assume we can construct it as follows: [A op B]

        const operation: ExpressionUnit = {
          type: 'binary',
          id: this.id_counter++,
          left,
          operator,
          position: operator_unit.position,
          right: element,
        };

        // we have to reorder if left (A) is a binary operation, and the
        // precedence of the new operator is higher. note that we will
        // deal with range operations later, for now just worry about
        // operator precedence

        if (
          left.type === 'binary' &&
          binary_operators_precendence[operator] >
          binary_operators_precendence[left.operator]
        ) {
          // so we have [[A op1 B] op2 C], and we need to re-order this into [A op1 [B op2 C]].

          operation.left = left.left; // <- A
          operation.operator = left.operator; // <- op1
          operation.position = left.position;
          operation.right = {
            type: 'binary',
            id: this.id_counter++,
            left: left.right, // <- B
            right: element, // <- C
            operator, // <- op2
            position: operator_unit.position,
          };
        }

        stack.splice(-2, 2, operation);
      }
      else {
        this.error = `multiple expressions`;
        this.error_position = (element as any).position;
        this.valid = false;
        return {
          type: 'group',
          id: this.id_counter++,
          elements: stream,
          explicit: false,
        };
      }
    }

    return stack[0];
  }

  /**
   * parses literals and tokens from the stream, ignoring whitespace,
   * and stopping on unexpected tokens (generally operators or parens).
   *
   * @param naked treat -/+ as signs (part of numbers) rather than operators.
   */
  protected ParseNext(naked = true): ExpressionUnit | number {

    this.ConsumeWhiteSpace();

    const char = this.data[this.index];
    if (char === DOUBLE_QUOTE) {
      return {
        type: 'literal',
        id: this.id_counter++,
        position: this.index,
        value: this.ConsumeString(),
      };
    }
    else if ((char >= ZERO && char <= NINE) || char === this.decimal_mark_char) {

      // FIXME: is there a case where period needs to be handled the
      // same way as plus and minus, below?

      /*
      const position = this.index;
      const [value, text] = this.ConsumeNumber();

      return {
        type: 'literal',
        id: this.id_counter++,
        position,
        value,
        text,
      };
      */

      return this.ConsumeNumber();

    }
    else if (char === OPEN_BRACE) {
      return this.ConsumeArray();
    }
    else if (naked && (char === MINUS || char === PLUS)) {

      // there's a case where you type '=-func()', which should support
      // '=+func()' as well, both of which are naked operators and not numbers.
      // the only way to figure this out is to check for a second number char.

      // this is turning into lookahead, which we did not want to do...

      const check = this.data[this.index + 1];
      if (
        (check >= ZERO && check <= NINE) ||
        check === this.decimal_mark_char
      ) {

        /*
        const position = this.index;
        const [value, text] = this.ConsumeNumber();

        return {
          type: 'literal',
          id: this.id_counter++,
          position,
          value,
          text,
        };
        */
       
        return this.ConsumeNumber();

      }
    }
    else if (
      (char >= UC_A && char <= UC_Z) ||
      (char >= LC_A && char <= LC_Z) ||
      char === UNDERSCORE ||
      char === SINGLE_QUOTE ||
      char === DOLLAR_SIGN ||
      (char >= ACCENTED_RANGE_START && char <= ACCENTED_RANGE_END) // adding accented characters, needs some testing
    ) {

      // FIXME: this only tests for ASCII tokens? (...)

      return this.ConsumeToken(char);
    }

    // else throw(new Error('Unexpected character: ' + char));
    return char;
  }

  protected ConsumeArray(): ExpressionUnit {

    const expression: UnitArray = {
      type: 'array',
      id: this.id_counter++,
      values: [],
      position: this.index,
    };

    this.index++;

    let row = 0;
    let column = 0;

    while (this.index < this.length) {
      const item = this.ParseNext();
      const start_position = this.index;

      if (typeof item === 'number') {
        this.index++;
        switch (item) {

          case SEMICOLON:
            //column = 0;
            //row++;
            column++;
            row = 0;
            break;

          case COMMA:
            //column++;
            row++;
            break;

          case CLOSE_BRACE:
            return expression;

          default:
            if (this.valid) {
              this.error = `invalid character in array literal`;
              this.error_position = start_position;
              this.valid = false;
            }
            break;
        }
      }
      else {
        switch (item.type) {
          case 'literal':
            if (!expression.values[row]) { expression.values[row] = []; }
            expression.values[row][column] = item.value;
            break;
          default:
            if (this.valid) {
              this.error = `invalid value in array literal`;
              this.error_position = start_position;
              this.valid = false;
            }
            break;
        }
      }
    }

    return expression;

  }

  protected ConsumeOperator(): ExpressionUnit | null {
    for (const operator of binary_operators) {
      if (this.expression.substr(this.index, operator.length) === operator) {
        const position = this.index;
        this.index += operator.length;
        return {
          type: 'operator',
          id: this.id_counter++,
          operator,
          position,
        };
      }
    }
    return null;
  }

  /** consume function arguments, which can be of any type */
  protected ConsumeArguments(): ExpressionUnit[] {
    this.index++; // open paren

    let argument_index = 0;
    const args: ExpressionUnit[] = [];

    for (; this.index < this.length;) {
      const unit = this.ParseGeneric([
        this.argument_separator_char,
        CLOSE_PAREN,
      ]);
      if (null !== unit) args.push(unit);

      // why did parsing stop?
      const char = this.data[this.index];

      if (char === this.argument_separator_char) {
        this.index++;
        argument_index++;
        for (let i = args.length; i < argument_index; i++) {
          args.push({ type: 'missing', id: this.id_counter++ });
        }
      }
      else if (char === CLOSE_PAREN) {
        this.index++;
        return args;
      }
      // else console.info('UNEXPECTED (CA)', char);
    }

    return args;
  }

  /**
   * consume token. also checks for function call, because parens
   * have a different meaning (grouping/precedence) when they appear
   * not immediately after a token.
   *
   * regarding periods: as long as there's no intervening whitespace
   * or operator, period should be a valid token character. tokens
   * cannot start with a period.
   *
   * NOTE: that's true irrespective of decimal mark type.
   *
   * you can have tokens (addresses) with single quotes; these are used
   * to escape sheet names with spaces (which is a bad idea, but hey). this
   * should only be legal if the token starts with a single quote, and only
   * for one (closing) quote.
   */
  protected ConsumeToken(initial_char: number): ExpressionUnit {
    const token: number[] = [initial_char];
    const position = this.index;

    let single_quote = (initial_char === SINGLE_QUOTE);

    for (++this.index; this.index < this.length; this.index++) {
      const char = this.data[this.index];
      if (
        (char >= UC_A && char <= UC_Z) ||
        (char >= LC_A && char <= LC_Z) ||
        (char >= ACCENTED_RANGE_START && char <= ACCENTED_RANGE_END) ||
        char === UNDERSCORE ||
        char === DOLLAR_SIGN ||
        char === PERIOD ||
        char === EXCLAMATION_MARK ||
        single_quote || // ((char === SINGLE_QUOTE || char === SPACE) && single_quote) ||
        (char >= ZERO && char <= NINE) // tokens can't start with a number, but this loop starts at index 1
      ) {
        token.push(char);
        if (char === SINGLE_QUOTE) {
          single_quote = false; // one only
        }
      }
      else break;
    }

    const str = token.map((num) => String.fromCharCode(num)).join('');

    // special handling: unbalanced single quote (probably sheet name),
    // this is an error

    if (single_quote) { // unbalanced

      this.error = `unbalanced single quote`;
      this.error_position = position;
      this.valid = false;

      return {
        type: 'identifier',
        id: this.id_counter++,
        name: str,
        position,
      } as UnitIdentifier;

    }

    // special handling

    if (str.toLowerCase() === 'true') {
      return {
        type: 'literal',
        id: this.id_counter++,
        value: true,
        position,
      };
    }
    if (str.toLowerCase() === 'false') {
      return {
        type: 'literal',
        id: this.id_counter++,
        value: false,
        position,
      };
    }

    // function takes precendence over address? I guess so

    this.ConsumeWhiteSpace();

    const next_char = this.data[this.index];
    if (next_char === OPEN_PAREN) {
      const args = this.ConsumeArguments();
      return {
        type: 'call',
        id: this.id_counter++,
        name: str,
        args,
        position,
      };
    }

    // check for address. in the case of a range, we'll see an address, the
    // range operator, and a second address. that will be turned into a range
    // later.

    const address = this.ConsumeAddress(str, position);
    if (address) return address;

    const identifier: UnitIdentifier = {
      type: 'identifier',
      id: this.id_counter++,
      name: str,
      position,
    };

    this.full_reference_list.push(identifier);

    return identifier;
  }

  /**
   * consumes address. this is outside of the normal parse flow;
   * we already have a token, here we're checking if it's an address.
   *
   * this used to check for ranges as well, but we now treat ranges as
   * an operation on two addresses; that supports whitespace between the
   * tokens.
   *
   * FIXME: that means we can now inline the column/row routines, since
   * they are not called more than once
   */
  protected ConsumeAddress(
    token: string,
    position: number,
  ): UnitAddress | null {
    const index = position;
    const token_length = token.length;

    // FIXME: should mark this (!) when it hits, rather than search

    // UPDATE: ! is legal in sheet names, although it needs to be quoted.

    let sheet: string | undefined;
    const tokens = token.split('!');

    if (tokens.length > 1) {
      sheet = tokens.slice(0, tokens.length - 1).join('!');
      position += sheet.length + 1;
    }

    /*
    if (tokens.length === 2) {
      sheet = tokens[0];
      position += (tokens[0].length + 1);
    }
    */

    // FIXME: can inline

    const c = this.ConsumeAddressColumn(position);
    if (!c) return null;
    position = c.position;

    const r = this.ConsumeAddressRow(position);
    if (!r) return null;
    position = r.position;

    const label = sheet ?
      sheet + token.substr(sheet.length, position - index).toUpperCase() :
      token.substr(0, position - index).toUpperCase();

    if (sheet && sheet[0] === '\'') {
      sheet = sheet.substr(1, sheet.length - 2);
    }

    const addr: UnitAddress = {
      type: 'address',
      id: this.id_counter++,
      label, // : token.substr(0, position - index).toUpperCase(),
      row: r.row,
      column: c.column,
      absolute_row: r.absolute,
      absolute_column: c.absolute,
      position: index,
      sheet,
    };

    // if that's not the complete token, then it's invalid

    if (token_length !== position - index) return null;

    // store ref, increment count

    this.dependencies.addresses[addr.label] = addr;
    this.address_refcount[addr.label] =
      (this.address_refcount[addr.label] || 0) + 1;

    // add to new address list. use the actual object (not a clone or copy);
    // we update the list later, and we may want to remove it (if it turns
    // out it's part of a range)

    this.full_reference_list.push(addr);

    return addr;
  }

  /**
   * consumes a row, possibly absolute ($). returns the numeric row
   * (0-based) and metadata
   */
  protected ConsumeAddressRow(position: number): 
    { 
      absolute: boolean;
      row: number;
      position: number;
    }|false {

    const absolute = this.data[position] === DOLLAR_SIGN;
    if (absolute) position++;

    const start = position;
    let value = 0;

    for (; ; position++) {
      const char = this.data[position];
      if (char >= ZERO && char <= NINE) {
        value *= 10;
        value += char - ZERO;
      }
      else break;
    }

    if (start === position) return false;
    return { absolute, row: value - 1, position };
  }

  /**
   * consumes a column, possibly absolute ($). returns the numeric
   * column (0-based) and metadata
   */
  protected ConsumeAddressColumn(position: number):
    { 
      absolute: boolean;
      column: number;
      position: number;
    }|false {

    let column = -1; // clever
    let length = 0; // max 3 chars for column

    const absolute = this.data[position] === DOLLAR_SIGN;
    if (absolute) position++;

    for (; ; position++, length++) {
      if (length >= 4) return false; // max 3 chars for column

      const char = this.data[position];
      if (char >= UC_A && char <= UC_Z) {
        column = 26 * (1 + column) + (char - UC_A);
      }
      else if (char >= LC_A && char <= LC_Z) {
        column = 26 * (1 + column) + (char - LC_A);
      }
      else break;
    }

    if (column < 0) return false;
    return { absolute, column, position };
  }

  /**
   * consumes number. supported formats (WIP):
   *
   * -3
   * +3
   * 100.9
   * 10.0%
   * 1e-2.2
   *
   * ~1,333,123.22~
   *
   * UPDATE: commas (separators) are not acceptable in numbers passed
   * in formulae, can't distinguish between them and function argument
   * separators.
   *
   * regarding the above, a couple of rules:
   *
   * 1. +/- is only legal in position 0 or immediately after e/E
   * 2. only one decimal point is allowed.
   * 3. any number of separators, in any position, are legal, but
   *    only before the decimal point.
   * 4. only one % is allowed, and only in the last position
   *
   * NOTE: this is probably going to break on unfinished strings that
   * end in - or +... if they're not treated as operators...
   *
   * FIXME: find test cases for that so we can fix it
   *
   * UPDATE: exporting original text string for preservation/insertion.
   * this function now returns a tuple of [value, text].
   *
   * UPDATE: we now (at least in a branch) consume complex numbers. the last 
   * element of the return array is a boolean which is set if the value is an 
   * imaginary number. when parsing, we will only see the imaginary part; 
   * we'll use a separate step to put complex numbers together.
   * 
   * 
   */
  protected ConsumeNumber(): ExpressionUnit { // [number, string, boolean] {

    const starting_position = this.index;

    // for exponential notation
    let exponent = 0;
    let negative_exponent = false;

    // general
    let negative = false;
    let integer = 0;
    let decimal = 0;
    let fraction = 0;

    let state: 'integer' | 'fraction' | 'exponent' = 'integer';
    let position = 0;

    let imaginary = false;

    const start_index = this.index;

    for (; this.index < this.length; this.index++, position++) {
      const char = this.data[this.index];

      if (char === this.decimal_mark_char) {
        if (state === 'integer') state = 'fraction';
        else break; // end of token; not consuming
      }
      else if (char === PERCENT) {
        // FIXME: disallow combination of exponential and percent notation

        integer /= 100; // this is a dumb way to do this
        fraction /= 100;

        this.index++; // we are consuming
        break; // end of token
      }
      else if (char === PLUS || char === MINUS) {
        // NOTE: handling of positive/negative exponent in exponential
        // notation is handled separately, see below

        if (position === 0) {
          if (char === MINUS) negative = true;
        }
        else break; // end of token -- not consuming
      }
      // else if (char === COMMA){
      //  // ... FIXME: validate that we're in the integer part
      // }
      else if (char === UC_E || char === LC_E) {
        if (state === 'integer' || state === 'fraction') {
          state = 'exponent';
          if (this.index < this.length - 1) {
            if (this.data[this.index + 1] === PLUS) this.index++;
            else if (this.data[this.index + 1] === MINUS) {
              this.index++;
              negative_exponent = true;
            }
          }
        }
        else break; // not sure what this is, then
      }
      else if (char === this.imaginary_char && this.support_complex_numbers) {
        if (state === 'integer' || state === 'fraction') {
          this.index++; // consume
          imaginary = true;
          break; // end of token
        }
      }
      else if (char >= ZERO && char <= NINE) {
        switch (state) {
          case 'integer':
            integer = integer * 10 + (char - ZERO);
            break;
          case 'fraction':
            fraction = fraction * 10 + (char - ZERO);
            decimal++;
            break;
          case 'exponent':
            exponent = exponent * 10 + (char - ZERO);
            break;
        }
      }
      else break;
    }

    let value = integer + fraction * Math.pow(10, -decimal);

    if (state === 'exponent') {
      value = value * Math.pow(10, (negative_exponent ? -1 : 1) * exponent);
    }

    // const text = this.expression.substring(start_index, this.index) || '';
    // return [negative ? -value : value, text, imaginary];

    return {
      type: imaginary ? 'imaginary' : 'literal',
      id: this.id_counter++,
      position: starting_position,
      value: negative ? -value : value,
      text: this.expression.substring(start_index, this.index) || '',
    };

  }

  /**
   * in spreadsheet language ONLY double-quoted strings are legal. there
   * are no escape characters, and a backslash is a legal character. to
   * embed a quotation mark, use "" (double-double quote); that's an escaped
   * double-quote.
   */
  protected ConsumeString(): string {
    this.index++; // open quote
    const str: number[] = [];

    for (; this.index < this.length; this.index++) {
      const char = this.data[this.index];
      if (char === DOUBLE_QUOTE) {
        // always do this: either it's part of the string (and
        // we want to skip the next one), or it's the end of the
        // string and we want to close the literal.

        this.index++;

        // check for an escaped double-quote; otherwise close the string
        // note (1) we already incremented, so check the current value,
        // and (2) it will increment again on the loop pass so it will
        // drop the extra one. I note these because this was confusing to
        // write.

        if (
          this.index >= this.length ||
          this.data[this.index] !== DOUBLE_QUOTE
        ) {
          break;
        }
      }
      str.push(char);
    }

    return str.map((char) => String.fromCharCode(char)).join('');
  }

  /** run through any intervening whitespace */
  protected ConsumeWhiteSpace(): void {
    for (; this.index < this.length;) {
      const char = this.data[this.index];
      if (
        char === SPACE ||
        char === TAB ||
        char === CR ||
        char === LF ||
        char === NON_BREAKING_SPACE
      ) {
        this.index++;
      }
      else return;
    }
  }
}
