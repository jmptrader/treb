
import { SpreadsheetVertexBase } from './spreadsheet_vertex_base';
import { Cell, ICellAddress, ValueType } from 'treb-base-types';
import { ExpressionUnit } from 'treb-parser';
import { Color } from './vertex';

type Graph = import('./graph').Graph; // circular; type only

export enum SpreadsheetError {
  None,
  CalculationError,
}

export interface CalculationResult {
  value: any;
  volatile?: boolean;
}

/**
 * specialization of vertex with attached data and calculation metadata
 */
export class SpreadsheetVertex extends SpreadsheetVertexBase {

  public reference?: Cell;

  public error = SpreadsheetError.None;

  // why is this (?)? can't we use a default junk address?
  public address?: ICellAddress;

  public result: any;
  public expression: ExpressionUnit = { type: 'missing', id: -1 };
  public expression_error = false;
  public short_circuit = false;

  public type = 'spreadsheet-vertex'; // for type guard

  /** 
   * it seems like this could be cached, if it gets checked a lot 
   * also what's with the crazy return signature? [fixed]
   */
  get array_head(): boolean {
    if (!this.address) return false;
    return (!!this.reference)
      && (!!this.reference.area)
      && (this.reference.area.start.column === this.address.column)
      && (this.reference.area.start.row === this.address.row);

  }

  /**
   * to support restoring cached values (from file), we need a way to get
   * the value from the reference (cell). normally this is done during
   * calculation, and in reverse (we set the value).
   *
   * some additional implications of this:
   *
   * - does not set volatile/nonvolatile, which is usually managed as a
   *   side-effect of the calculation.
   *
   * - does not remove the entry from the dirty list
   *
   * - does not clear the internal dirty flag. it used to do that, but we
   *   took it out because we are now managing multple vertex types, and
   *   we don't want to attach that behavior to a type-specific method.
   *
   * so the caller needs to explicitly address the dirty and volatile lists
   * for this vertex.
   */
  public TakeReferenceValue() {
    if (this.reference) {
      this.result = this.reference.GetValue();
    }
  }

  /**
   * calculates the function, but only if all dependencies are clean.
   * if one or more dependencies are dirty, just exit. this should work out
   * so that when the last dependency is satisfied, the propagation will
   * succeed. FIXME: optimize order.
   *
   * FIXME: why is this in vertex, instead of graph? [a: dirty check?]
   * A: for overloading. leaf extends this class, and has a separate
   * calculation routine.
   */
  public Calculate(graph: Graph): void {

    if (!this.dirty) return;

    // it would be nice if we could get this out of the calculate routine,
    // but that's a problem because we can't calculate in the right order.

    // one solution might be to have two methods, one which includes it
    // and one which doesn't, and call the checked method only when necessary.
    // OTOH that means maintaining the internal calculation part twice (or
    // adding a method call).

    // especially for simulation, where we can determine ahead of time if
    // there are any loops

    if (this.color === Color.white && this.LoopCheck()) {

      // console.info('LC', `R${this.address?.row} C${this.address?.column}`, this);

      // if (this.LoopCheck()) {
        // throw new Error('loop loop 2')

        this.dirty = false;

        if (this.edges_in.length) {

          // console.info('set loop err', `R${this.address?.row} C${this.address?.column}`, this);

          // this should alwys be true, because it has edges so
          // it must be a formula (right?)

          // we don't have to do that test because now we only set
          // vertices -> white if they match

          if (this.reference && (
              this.array_head || this.reference.type === ValueType.formula )) {
            this.reference.SetCalculationError('LOOP');
          }
          //this.reference?.SetCalculationError('LOOP');

          // intuitively this seems like a good idea but I'm not sure
          // that it is actually necessary (TODO: check)

          for (const edge of this.edges_out){
            (edge as SpreadsheetVertex).Calculate(graph);
          }
        
          return;

        }
        /*
        else {
          console.info('SKIP loop err', `R${this.address?.row} C${this.address?.column}`, this);
        }
        */

      // }
    }

    // this is done before checking if it's a formula for the case of
    // arrays: arrays are not formulae but they are dependent on the
    // array head. if the head is dirty we need to calculate that before
    // any dependents of _this_ cell are calculated.

    // the head calculation should take care of setting this value, that is,
    // we don't need to do the actual lookup.

    // this prevents a runaway if there's a loop (and we are not catching it),
    // but there's a side-effect: the dirty flag never gets cleared. if we want
    // to fix this we need to clean the dirty flag on vertices before a full 
    // recalc, I guess...

    // that's also why page reload "fixes" the issue: because there's a global
    // cleaning of dirty flags. or maybe they don't survive serialization, I don't know.

    for (const edge of this.edges_in) {
      if ((edge as SpreadsheetVertexBase).dirty) {
        // console.info('exiting on dirty deps', `R${this.address?.row} C${this.address?.column}`, this);
        return;
      }
    }

    // console.info('OK calc', `R${this.address?.row} C${this.address?.column}`, this);

    // we won't have a reference if the reference is to an empty cell,
    // so check that. [Q: what?]

    if (this.reference) {

      if (this.reference.type === ValueType.formula) {

        this.short_circuit = false;
        const result = graph.CalculationCallback.call(graph, this);
        this.result = result.value;

        // this test is a waste for 99% of calls 
        //
        // [FYI it has to do with dynamic dependencies, needs to be documented]
        //
        if (this.short_circuit) { return; } // what about setting dirty flag? (...)

        // and this one for ~75%?
        if (result.volatile) graph.volatile_list.push(this);
      }
      else this.result = this.reference.GetValue();

      // is this going to work properly if it's an error? (...)

      if (this.array_head) {
        graph.SpreadCallback.call(graph, this, this.result);
      }
      else if (this.reference.type === ValueType.formula) {
        if (typeof this.result === 'object' && this.result.error) {
          this.reference.SetCalculationError(this.result.error);
        }
        else {
          this.reference.SetCalculatedValue(this.result);
        }
      }

    }
    else {
      console.info('skip dirty constant? [or dangling...]');
    }

    this.dirty = false;

    for (const edge of this.edges_out){
      (edge as SpreadsheetVertex).Calculate(graph);
    }

  }

}
