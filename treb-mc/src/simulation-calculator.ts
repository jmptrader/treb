
// this will move to a new subdir eventually so we can enforce isolation

import { Calculator } from 'treb-calculator';

import type { ICellAddress } from 'treb-base-types';

import type { DataModel } from 'treb-grid/src/types/data_model';
import { GraphStatus } from 'treb-calculator/src/dag/graph';

import * as PackResults from './pack-results';
import { MCExpressionCalculator } from './simulation-expression-calculator';
import { SimulationResultsData, SimulationState } from './simulation-model';

// we are stuck on an old version of this, and I can't remember 
// why; nor can I remember why this is better than any other solution 
// (including built-in browser functions) 

// whelp I guess I updated that, not broken, so NHNF?
import * as Base64JS from 'base64-js';

// testing (should remove)
import * as z85 from 'z85-codec';
import type { TREBSimulationData } from '../../treb-embed/src/types';
import type { ExtendedSerializeOptions } from './extended-serialize-options';


export class MCCalculator extends Calculator {

  // FIXME: remove from calculator class
  // protected readonly simulation_model = new SimulationModel();

  // reference
  protected simulation_expression_calculator: MCExpressionCalculator;

  // moved from embedded spreadsheet because of constructor
  // order/initialization timing issues. FIXME: access (+accessor)
  public last_simulation_data?: PackResults.ResultContainer;

  constructor(model: DataModel) {
    super(model);

    this.expression_calculator =
      this.simulation_expression_calculator = new MCExpressionCalculator(
        this.library,
        this.parser);

    // mc functions
    this.library.Register(this.simulation_expression_calculator.simulation_model.functions);

  }

  public InitSimulation(
    iterations: number,
    lhs: boolean,
    // cells: Cells,
    model: DataModel,
    additional_cells?: ICellAddress[],
    seed?: number): GraphStatus {

    const simulation_model = this.simulation_expression_calculator.simulation_model;

    simulation_model.iterations = iterations;
    simulation_model.results = [];
    simulation_model.lhs = lhs;
    simulation_model.correlated_distributions = {};

    if (typeof seed === 'number'){ 
      simulation_model.seed = seed;
    }

    // const cells = model.active_sheet.cells;

    // calling the flush method, instead of flushing tree directly,
    // will also set status -> OK. note that (atm, at least) we don't
    // need to deal with spreadsheet leaf nodes in the worker thread.

    this.Reset();
    // this.AttachData(model);
    // this.expression_calculator.SetModel(model);
    this.AttachModel();

    // add additional cells to monitor, but only if they actually
    // exist; otherwise they will generate calc errors. 
    //
    // cells passed as "additional cells" MUST HAVE SHEET ID (will throw)

    if (additional_cells && additional_cells.length) {
      for (const address of additional_cells) {

        if (!address.sheet_id) {
          throw new Error('additional cell passed without sheet id');
        }

        const sheet = this.model.sheets.Find(address.sheet_id);

        if (sheet) {
          const cell = sheet.cells.GetCell(address, false);
          if (cell) {
            simulation_model.StoreCellResults(address);
          }
        }

        /*
        const cell = cells.GetCell(address, false); // whoops
        if (cell) {
          simulation_model.StoreCellResults(address);
        }
        else console.info( 'Skipping empty cell', address);
        */

      }
    }

    this.RebuildGraph();

    if (this.LoopCheck()) {
      throw new Error('Loop (circular dependency) found in graph');
    }

    // NOTE: not dealing with annotations here. the rationale is that these
    // may have external function definitions, so we can't reliably get the
    // metadata. there should really be no reason to do this anyway... so
    // dropping annotations from simulation. someone else needs to get the
    // metadata for collecting results and pass it in (via additional_cells)

    // FIXME: consolidate with trial method

    simulation_model.state = SimulationState.Prep;
    simulation_model.iteration = 0;
    this.Recalculate();
    simulation_model.CorrelateDistributions();
    simulation_model.state = SimulationState.Simulation;

    return GraphStatus.OK; // result.status;

  }

  /**
   * returns simulation results. this is called after a simulation, results
   * will be returned from the worker(s) back to the main thread.
   */
  public GetResults(): SimulationResultsData {
    return this.simulation_expression_calculator.simulation_model.results;
  }


  /**
   * runs a single iteration in a simulation. calculation is simpler because
   * we know that nothing has changed in the graph since the last calculation
   * (since we set up the graph). the only things that are going to be dirty
   * are the volatile cells, which set set explicitly.
   */
  public SimulationTrial(iteration: number) {

    const simulation_model = this.simulation_expression_calculator.simulation_model;

    simulation_model.iteration = iteration;

    // now handled in graph/calc via volatile and simulationvolatile
    // Model.volatile_functions.forEach((addr) => this.SetDirty(addr));

    // there's no loop check here because the graph can't change between
    // init() and here; although the loop check would theoretically short-
    // circuit anyway, since it's gated

    try {
      this.Recalculate();

      // FIXME: we should pull out index pairs once, then refer
      // to the list. while this probably isn't slow, it seems
      // unecessary.

      // tslint:disable-next-line:forin
      for (const id in simulation_model.results) {

        // we should validate this, but I don't want to do that on every
        // trial... can we precheck against collected cells, before running?
        // maybe in prep? (...)

        const cells = this.model.sheets.Find(id)?.cells;
        if (cells) {
          // const cells = this.cells_map[id];

          // tslint:disable-next-line:forin
          for (const c in simulation_model.results[id]){
            const column = simulation_model.results[id][c];

            // tslint:disable-next-line:forin
            for (const r in column){

              const cell = cells.GetCell({row: Number(r), column: Number(c)});

              // it seems like this is a waste -- if the cell doesn't exist,
              // we should remove it from the list (or not add it in the first
              // place). that prevents it from getting tested every loop.

              if (cell){
                const value = cell.GetValue();
                switch (typeof value){
                  case 'number': column[r][iteration] = value; break;
                  case 'boolean': column[r][iteration] = value ? 1 : 0; break;
                  default: column[r][iteration] = 0;
                }
              }
            }
          }
        }
      }
      return { status: GraphStatus.OK, reference: null };
    }
    catch (err){
      console.info('calculation error trapped', err);
      return { status: GraphStatus.CalculationError, reference: null };
    }

  }


  /**
   * flattens results for passing to the main thread from worker
   */
  public FlattenedResults(): ArrayBuffer[] {

    const simulation_model = this.simulation_expression_calculator.simulation_model;

    // flatten into buffers
    const flattened: ArrayBuffer[] = [];

    // tslint:disable-next-line:forin
    for (const id in simulation_model.results) {

      // tslint:disable-next-line:forin
      for (const c in simulation_model.results[id]) {
        const column = simulation_model.results[id][c];

        // tslint:disable-next-line:forin
        for (const r in column) {
          flattened.push(PackResults.PackOne({
            row: Number(r), column: Number(c), sheet_id: Number(id), data: column[r] }).buffer);
        }
      }
    }
    return flattened;
  }

  /** basically set null results */
  public FlushSimulationResults(): void {
    const simulation_model = this.simulation_expression_calculator.simulation_model;

    simulation_model.results = [];
    simulation_model.elapsed = 0;
    simulation_model.trials = 0;

    this.last_simulation_data = undefined;
  }

  /** TODO */
  public ShiftSimulationResults(before_row: number, before_column: number, rows: number, columns: number) {
    // ...
  }

  public SerializeSimulationData(options: ExtendedSerializeOptions): TREBSimulationData {

    const data: TREBSimulationData = {
      elapsed: this.last_simulation_data?.elapsed || 0,
      trials: this.last_simulation_data?.trials || 0,
      results: undefined,
    };

    const results = this.last_simulation_data?.results || [];

    // NOTE: the z85 code below does not ensure the source data is
    // length-divisible by 4. that's required for z85 and also for
    // this library, apparently, so it will probably break.
    // 
    // I think we should use z85, but we need to do it properly.
    //
    // ...although, we're encoding a bunch of either 32-bit or 64-bit
    // numbers. so we will almost certainly always have properly sized
    // data. 
    //
    // still, that apparently happened by accident and not because we
    // were being clever.


    // testing 32-bit data...

    if (options.float32) {
      data.bitness = 32;
      data.results = results.map(result => {

        // 64 -> 32
        const array32 = Float32Array.from(new Float64Array(result)); 
        return options.z85 ? 
            z85.encode(new Uint8Array(array32.buffer)) : 
            Base64JS.fromByteArray(new Uint8Array(array32.buffer));
      });
    }
    else {
      data.results = results.map(result => {
        return options.z85 ? 
            z85.encode(new Uint8Array(result)) : 
            Base64JS.fromByteArray(new Uint8Array(result));
      });
    }

    if (options.z85) { 
      data.encoding = 'z85'; 
    }

    return data;

  }

  public UnserializeSimulationData(data: TREBSimulationData): void {

    const z = data.encoding === 'z85';
    this.last_simulation_data = data;

    if (data.bitness === 32) {
        this.last_simulation_data.results =
          (this.last_simulation_data.results || []).map((entry) => {
            if (z) {
              const decoded = z85.decode(entry as any);
              return decoded ? Float64Array.from(decoded).buffer : new Float64Array().buffer;
            }
            else {
              const array32 = new Float32Array(Base64JS.toByteArray(entry as any).buffer);
              return Float64Array.from(array32).buffer;
            }
          });

      }
      else {
        this.last_simulation_data.results =
          (this.last_simulation_data.results || []).map((entry) => {
            if (z) {
              const decoded = z85.decode(entry as any);
              return decoded ? decoded.buffer : new Uint8Array().buffer;
            }
            else {
              return Base64JS.toByteArray(entry as any).buffer;
            }
          });
      }

      this.UpdateResults(false);

  }

  /**
   * updates simulation results for watched cells. after a simulation,
   * these will generally come in from the worker thread. FIXME: move
   * worker in here?
   *
   * once these are set, simulation functions (e.g. mean) can return
   * results
   *
   * @param model model passed directly, in case the model has not yet
   * been set; we may need this for assigning simulation results from
   * older files.
   *
   * @param set_dirty ordinarily we would set the cell dirty, but on
   * load it may not yet be available, and we are going to mark it dirty
   * later anyway -- so pass false to skip.
   */
  public UpdateResults(set_dirty = true){

    //if (!model) {
    //  throw new Error('UpdateResults called without model');
    //}

    const simulation_model = this.simulation_expression_calculator.simulation_model;

    const data = this.last_simulation_data;
    
    if (!data) {
      simulation_model.results = [];
      simulation_model.elapsed = 0;
      simulation_model.trials = 0;
    }
    else {
      simulation_model.results = [];
      simulation_model.elapsed = data.elapsed;
      simulation_model.trials = data.trials;

      for (const result of data.results) {

        const entry = (result instanceof ArrayBuffer) ? PackResults.UnpackOne(new Float64Array(result)) : result;

        if (!entry.sheet_id) {
          entry.sheet_id = this.model.sheets.list[0].id; // patch for old-style data
        }

        /** ?
        if (!entry.sheet_id) {
          entry.sheet_id = model.active_sheet.id;
        }
        */

        if (!simulation_model.results[entry.sheet_id]){
          simulation_model.results[entry.sheet_id] = [];
        }

        if (!simulation_model.results[entry.sheet_id][entry.column]) {
          simulation_model.results[entry.sheet_id][entry.column] = [];
        }

        simulation_model.results[entry.sheet_id][entry.column][entry.row] = entry.data as any;
        if (set_dirty) {
          // console.info('set dirty', entry);
          this.SetDirty(entry);
        }

      }
    }

  }

  /*
   * no longer overloading. call flush explicitly. there are two reasons for
   * this: one, so we can stop overloading with a different signature; and two,
   * because there's a local cache in caller that needs to be handled, so
   * better to be explicit.
   *
   * OVERLOAD
   * resets graph and graph status
   *
   * this should not work... we have a different signature than the base
   * class method: shouldn't ts complain about that? not sure what the
   * correct thing is. even if it works, we should perhaps not do it.
   *
   * /
  public Reset(flush_results = true){

    super.Reset();

    if (flush_results){
      this.FlushSimulationResults(); // to prevent ghost data
    }

  }
  */

}
