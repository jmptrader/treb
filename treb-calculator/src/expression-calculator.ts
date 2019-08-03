
// import { Model, SpreadsheetFunctions, SimulationState } from './spreadsheet-functions';
// import { Model, SimulationState } from './spreadsheet-functions';

import { SimulationModel, SimulationState } from './simulation-model';
import { FunctionLibrary } from './function-library';

import { Localization, Cells, ICellAddress, ValueType, Area } from 'treb-base-types';
import { Parser, ExpressionUnit, DecimalMarkType, ArgumentSeparatorType } from 'treb-parser';

import { DataModel, NamedRangeCollection } from 'treb-grid';

export interface CalculationContext {
  address: ICellAddress;
}

export class ExpressionCalculator {

  /** context for function call reference */
  public context: CalculationContext = {
    address: {row: -1, column: -1},
  };

  private call_index = 0;
  private cells: Cells = new Cells();
  private data_model!: DataModel;
  private named_range_map: {[index: string]: Area} = {};
  private parser: Parser; // = new Parser();

  private simulation_model!: SimulationModel;
  private library!: FunctionLibrary;

  constructor(){
    this.parser = new Parser();
    this.UpdateLocale();
  }

  /**
   * FIXME: we should unify with calculator, which also has a parser
   * and which also has to manage locale. we only need one.
   */
  public UpdateLocale(){
    if (Localization.decimal_separator === ',') {
      this.parser.decimal_mark = DecimalMarkType.Comma;
      this.parser.argument_separator = ArgumentSeparatorType.Semicolon;
    }
    else {
      this.parser.decimal_mark = DecimalMarkType.Period;
      this.parser.argument_separator = ArgumentSeparatorType.Comma;
    }
  }

  public SetModel(model: DataModel, simulation_model: SimulationModel, library: FunctionLibrary) {
    this.cells = model.sheet.cells;
    this.data_model = model;
    this.named_range_map = model.sheet.named_ranges.Map();
    this.simulation_model = simulation_model;
    this.library = library;
  }

  /**
   * instead of calculating, just check if the cell is volatile. this is
   * done by walking the expression, and checking any function calls.
   * everything else is ignored.
   */
  public CheckVolatile(expr: ExpressionUnit) {
    let volatile = false;

    this.parser.Walk(expr, (unit: ExpressionUnit) => {
      if (unit.type === 'call') {
        const func = this.library.Get(unit.name);
        if (func && func.volatile) volatile = true;
      }
      return !volatile; // short circuit
    });

    return volatile;
  }

  /**
   * there's a case where we are calling this from within a function
   * (which is weird, but hey) and to do that we need to preserve flags.
   */
  public Calculate(expr: ExpressionUnit, addr: ICellAddress, preserve_flags = false){

    if (!preserve_flags) {
      this.simulation_model.address = addr;
      this.simulation_model.volatile = false;
      this.context.address = addr;
      this.call_index = 0; // why not in model? A: timing (nested)
    }

    return {
      value: this.CalculateExpression(expr),
      volatile: this.simulation_model.volatile,
    };
  }

  /**
   * we pass around errors as objects with an error (string) field.
   * this is a simplified check for that type.
   */
  protected IsError(value: any) {
    return (typeof value === 'object') && value.error;
  }

  /**
   * returns value for address/range
   *
   * note we are "fixing" strings with leading apostrophes. that should
   * probably be done inside the cell, via a separate method.
   *
   * UPDATE: propagate cell errors
   */
  protected CellFunction(c1: number, r1: number, c2?: number, r2?: number){
    if (typeof c2 === 'undefined' || typeof r2 === 'undefined') {
      const cell = this.cells.GetCell({row: r1, column: c1});
      if (!cell) return undefined;
      if (cell.calculated_type === ValueType.error) return { error: cell.GetValue() };
      return cell.GetValue();
    }
    else {
      return(this.cells.GetRange2(
        {row: r1, column: c1},
        {row: r2, column: c2},
        true,
      ));
    }
  }

  /** excutes a function call */
  protected CallExpression(expr: string, args: ExpressionUnit[] = []){

    const call_index = this.call_index; // trap value, it may increment

    const func = this.library.Get(expr);

    if (!func) return { error: 'NAME' };

    // yeah so this is clear

    this.simulation_model.volatile = this.simulation_model.volatile || (!!func.volatile) ||
      ((!!func.simulation_volatile) && this.simulation_model.state !== SimulationState.Null);

    // NOTE: this is (possibly) calculating unecessary operations, if there's
    // an IF statement. although that is the exception rather than the rule...

    let argument_errors = false; // maybe short-circuit

    const argument_descriptors = func.arguments || []; // map

    const mapped_args = args.map((arg, arg_index) => {

      if (typeof arg === 'undefined') { return undefined; } // FIXME: required?

      const descriptor = argument_descriptors[arg_index] || {};

      // FIXME (address): what about named ranges (actually those will work),
      // constructed references (we don't support them atm)?

      // NOTE: named ranges will _not_ work, because the address will be an
      // object, not a string. so FIXME.

      if (descriptor.address) {
        return this.parser.Render(arg).replace(/\$/g, '');
      }
      else if (descriptor.metadata) {

        // FIXME: we used to restrict this to non-cell functions, now
        // we are using it for the cell function (we used to use address,
        // which just returns the label)

        let address: ICellAddress|undefined;

        switch (arg.type) {
        case 'address':
          address = arg;
          break;

        case 'range':
          address = arg.start;
          break;

        case 'identifier':
          const named_range = this.named_range_map[arg.name.toUpperCase()];
          if (named_range) {
            address = named_range.start; // FIXME: range?
          }
        }

        if (address) {

          const cell_data = this.data_model.sheet.CellData(address);
          const simulation_data =
            (this.simulation_model.state === SimulationState.Null) ?
            this.simulation_model.CellData(address) :
            [];

          return {
            address: {...address},
            value: cell_data.calculated,
            format: cell_data.style ? cell_data.style.number_format : undefined,
            simulation_data,
          };
        }

      }
      else if (descriptor.collector && this.simulation_model.state === SimulationState.Null) {

        // why holding this twice? (...) has to do with timing, apparently...
        this.simulation_model.call_index = call_index;

        if (arg.type === 'address'){
          return this.simulation_model.CellData(arg);
        }
        else if (arg.type === 'range') {
          return this.simulation_model.CellData(arg.start);
        }
        else if (arg.type === 'identifier') {
          const named_range = this.named_range_map[arg.name.toUpperCase()];
          if (named_range) {
            return this.simulation_model.CellData(named_range.start);
          }
        }


      }
      else {
        const result = this.CalculateExpression(arg);
        if (typeof result === 'object' && result.error && !descriptor.allow_error) {
          argument_errors = true;
        }
        return result;
      }

      return undefined; // default

    });

    if (argument_errors) {
      return { error: 'ARG' };
    }

    if (this.simulation_model.state === SimulationState.Prep){

      // this is a separate loop because we only need to call it on prep
      // FIXME: can this move to parsing stage? (old note: probably this too, with a flag)

      args.forEach((arg, arg_index) => {
        const descriptor = argument_descriptors[arg_index] || {};
        if (arg && descriptor.collector) {
          if (arg.type === 'address') {
            this.simulation_model.CellData(arg);
          }
          else if (arg.type === 'identifier') {
            const named_range = this.named_range_map[arg.name.toUpperCase()];
            if (named_range) {
              this.simulation_model.CellData(named_range.start);
            }
          }
        }
      });

    }

    // I thought we were passing the model as this (...) ? actually
    // now we bind functions that need this, so maybe we should pass
    // null here.

    return func.fn.apply(FunctionLibrary, mapped_args);

  }

  protected UnaryExpression(operator: string, operand: any){
    operand = this.CalculateExpression(operand);

    if (Array.isArray(operand)){
      switch (operator){
      case '-':
        for (const column of operand){
          for (let r = 0; r < column.length; r++) column[r] = -column[r];
        }
        break;
      case '+':
        break;
      default:
        console.warn('unexpected unary operator:', operator);
        for (const column of operand){
          for (let r = 0; r < column.length; r++) {
            column[r] = { error: 'EXPR' }; // '#ERR';
          }
        }
      }
      return operand;
    }

    if (typeof operand === 'object' && operand.error) return {...operand}; // propagate

    switch (operator){
    case '-': return -operand;
    case '+': return operand;
    default:
      console.warn('unexpected unary operator:', operator);
    }

    return { error: 'EXPR' };
  }

  /**
   * FIXME: did we drop this from the parser? I think we may have.
   * use logical functions AND(), OR()
   */
  protected LogicalExpression(operator: string, left: any, right: any){

    // sloppy typing, to support operators? (...)

    left = this.CalculateExpression(left);
    right = this.CalculateExpression(right);

    switch (operator){
    case '||': return left || right;
    case '&&': return left && right;
    }


    console.info(`(unexpected logical operator: ${operator})`);
    return {error: 'EXPR'};

  }

  /**
   * applies operation over values (guaranteed to be scalars). this is wasteful
   * when applied to matrices, because we do the test over and over. TODO: inline.
   *
   * @param operator
   * @param left scalar
   * @param right scalar
   */
  protected ElementalBinaryExpression(operator: string, left: any, right: any){

    // propagate errors

    if (typeof left === 'object' && left.error) return {...left};
    if (typeof right === 'object' && right.error) return {...right};

    switch (operator){
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      case '/': return left / right;
      case '^': return Math.pow(left, right);
      case '%': return left % right;
      case '>': return left > right;
      case '<': return left < right;
      case '>=': return left >= right;
      case '<=': return left <= right;

      // tslint:disable-next-line:triple-equals
      case '!==': return left != right;

      // tslint:disable-next-line:triple-equals
      case '<>': return left != right;

      // tslint:disable-next-line:triple-equals
      case '=': return left == right;

      // tslint:disable-next-line:triple-equals
      case '==': return left == right;
      }

      console.info(`(unexpected binary operator: ${operator})`);
      return {error: 'EXPR'};

  }

  /**
   * expands the size of an array by recycling values in columns and rows
   *
   * @param arr 2d array
   * @param columns target columns
   * @param rows target rows
   */
  protected RecycleArray(arr: any[][], columns: number, rows: number){

    // NOTE: recycle rows first, more efficient. do it in place?

    if (arr[0].length < rows) {
      const len = arr[0].length;
      for (const column of arr) {
        for (let r = len; r < rows; r++ ) {
          column[r] = column[r % len];
        }
      }
    }

    if (arr.length < columns) {
      const len = arr.length;
      for (let c = len; c < columns; c++) arr[c] = arr[c % len].slice(0);
    }

    return arr;
  }

  /**
   * applies binary operator elementwise over array
   *
   * @param operator
   * @param left guaranteed to be 2d array
   * @param right guaranteed to be 2d array
   */
  protected ElementwiseBinaryExpression(operator: string, left: any[][], right: any[][]){

    const columns = Math.max(left.length, right.length);
    const rows = Math.max(left[0].length, right[0].length);

    left = this.RecycleArray(left, columns, rows);
    right = this.RecycleArray(right, columns, rows);

    const result = [];

    for (let c = 0; c < columns; c++) {
      const col = [];
      for (let r = 0; r < rows; r++ ) {
        col[r] = this.ElementalBinaryExpression(operator, left[c][r], right[c][r]);
      }
      result.push(col);
    }

    return result;
  }

  protected BinaryExpression(operator: string, left: any, right: any){

    // sloppy typing, to support operators? (...)

    left = this.CalculateExpression(left);
    right = this.CalculateExpression(right);

    // check for arrays. do elementwise operations.

    if (Array.isArray(left)){
      if (Array.isArray(right)){
        return this.ElementwiseBinaryExpression(operator, left, right);
      }
      else {
        return this.ElementwiseBinaryExpression(operator, left, [[right]]);
      }
    }
    else if (Array.isArray(right)) {
      return this.ElementwiseBinaryExpression(operator, [[left]], right);
    }

    // propagate errors

    if (typeof left === 'object' && left.error) return {...left};
    if (typeof right === 'object' && right.error) return {...right};

    switch (operator){
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return left / right;
    case '^': return Math.pow(left, right);
    case '%': return left % right;
    case '>': return left > right;
    case '<': return left < right;
    case '>=': return left >= right;
    case '<=': return left <= right;

    // tslint:disable-next-line:triple-equals
    case '!==': return left != right;

    // tslint:disable-next-line:triple-equals
    case '<>': return left != right;

    // tslint:disable-next-line:triple-equals
    case '=': return left == right;

    // tslint:disable-next-line:triple-equals
    case '==': return left == right;
    }

    console.info(`(unexpected binary expr: ${operator})`);
    return {error: 'EXPR'};

  }

  /*
  protected ConditionalExpression(test: any, consequent: any, alternate: any){
    console.info( '** conditional expression', test);
    return 3;
  }
  */

  protected Identifier(name: string){

    switch (name.toLowerCase()){
    case 'false':
    case 'f':
      return false;

    case 'true':
    case 't':
      return true;

    case 'undefined':
      return undefined;
    }

    const named_range = this.named_range_map[name.toUpperCase()];

    if (named_range) {
      if (named_range.count === 1) {
        return this.CellFunction(
          named_range.start.column,
          named_range.start.row,
        );
      }
      else {
        return this.CellFunction(
          named_range.start.column,
          named_range.start.row,
          named_range.end.column,
          named_range.end.row,
        );
      }
    }

    console.info( '** identifier', name);
    return {error: 'NAME'};

  }

  protected CalculateExpression(expr: ExpressionUnit): any {

    switch (expr.type){
    case 'call':
      this.call_index++;
      return this.CallExpression(expr.name, expr.args);

    case 'address':
      return this.CellFunction(expr.column, expr.row);

    case 'range':
      return this.CellFunction(
        expr.start.column, expr.start.row,
        expr.end.column, expr.end.row );

    case 'binary':
      return this.BinaryExpression(expr.operator, expr.left, expr.right);

    case 'unary':
      return this.UnaryExpression(expr.operator, expr.operand);

    case 'identifier':
      return this.Identifier(expr.name);

    case 'missing':
      return undefined;

    case 'literal':
      return expr.value;

    case 'group':
      if (!expr.elements || expr.elements.length !== 1){
        console.warn( 'Can\'t handle group !== 1' );
        return 0;
      }
      return this.CalculateExpression(expr.elements[0]);

    default:
      console.warn( 'Unhandled parse expr:', expr);
      return 0;
    }
  }

}

