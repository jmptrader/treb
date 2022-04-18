
import { EmbeddedSpreadsheetBase } from '../../treb-embed/src/embedded-spreadsheet-base';
import { MCCalculator } from './simulation-calculator';
import { ResultContainer } from './pack-results';
import { CalculationWorker, WorkerMessage } from './worker-types';
import { ExtendedSerializeOptions } from './extended-serialize-options';
import { Random } from 'riskampjs-mc';

import { Localization, ICellAddress, IsCellAddress } from 'treb-base-types';
import { MacroFunction, SerializedNamedExpression } from 'treb-grid';
import { EmbeddedSheetEvent, CompositeEmbeddedSheetEvent, TREBDocument } from '../../treb-embed/src/types';

import * as PackResults from './pack-results'; // <-- why direct?

// config
import { DialogType } from '../../treb-embed/src/progress-dialog';
import { Calculator } from 'treb-calculator/src'; // <-- why direct?
import { EmbeddedSpreadsheetOptions, RunSimulationOptions } from '../../treb-embed/src/options';

export class EmbeddedSpreadsheet extends EmbeddedSpreadsheetBase<MCCalculator> {

  /** seed state for "replay simulation" */
  protected replay_buffer: number[] = [];

  /**
   * these (practically speaking, there should only be one) are resolve()
   * functions from running simulations. when a simulation is complete or
   * canceled, we will resolve and clear the list.
   */
  private simulation_resolution: Array<(...args: any) => void> = [];

  /**
   * calculation worker (no longer using worker-loader)
   *
   * NOTE: why is this managed by this class, and not by calculator?
   * it seems like that would better encapsulate the calculation.
   */
  private workers: CalculationWorker[] = [];

  private simulation_status = { 
    running: false,
    threads: 0,
    results: [] as ResultContainer[],
    completed: 0,
    progress: [] as number[],
    aggregate_progress: 0,
  };

  /**
   * see base type constructor
   */
  constructor(options: EmbeddedSpreadsheetOptions) {
    super(options, MCCalculator);
  }

  /**
   * some local cleanup, gets called in various import/load/reset functions
   */
  public ResetInternal(): void {
    super.ResetInternal();
    this.FlushSimulationResults(); // used to be in Reset()
  }

  /**
   * returns simulation data for a cell (if any)
   * 
   * this is an API method? (...) probably for RAW?
   */
  public SimulationData(address: string | ICellAddress): number[]|Float64Array|undefined {

    const area = this.calculator.ResolveAddress(address, this.grid.active_sheet);
    address = IsCellAddress(area) ? area : area.start;

    const sheet_id = address.sheet_id || this.grid.active_sheet.id;

    const data = this.calculator.GetResults();
    if (!data) return undefined;
    if (!data[sheet_id]) return undefined;
    if (!data[sheet_id][address.column]) return undefined;
    const cell = data[sheet_id][address.column][address.row];
    if (cell) {

      // legacy support. will need a polyfill regardless for Array.from
      return Array.isArray(cell) ? cell.slice(0) : Array.from(cell);
    }
    return undefined;
  }

  /**
   * override SerializeDocument. takes additional options for serializing
   * simulation data, compression and type
   * 
   * @param options 
   * @returns 
   */
  public SerializeDocument(options: ExtendedSerializeOptions = {}): TREBDocument {

    // add default, unless it's explicitly set

    options = {preserve_simulation_data: true, ...options};

    const serialized = super.SerializeDocument(options);

    if (options.preserve_simulation_data && this.calculator.last_simulation_data) {
      serialized.simulation_data = this.calculator.SerializeSimulationData(options);
    }

    return serialized;

  }

  /**
   * run MC simulation, in worker. worker is now demand-loaded, so first
   * pass may be slow.
   * 
   * we spend a lot of time setting and updating options, but no one uses
   * them; most callers set instance options, which are used by default. we
   * should remove one of these routes since it's confusing to have both.
   */
  public async RunSimulation(
      trials = this.options.default_trials || 5000,
      opts: Partial<RunSimulationOptions> = {}): Promise<void> {

    const { lhs, stepped, abort_on_dialog_close } = {
      abort_on_dialog_close: true,
      lhs: !!this.options.lhs,
      stepped: !!this.options.screen_updates,
      ...opts,
    };

    let additional_cells = opts.additional_cells||[]; 

    if (this.simulation_status.running) {
      throw new Error('simulation already running');
    }

    if (typeof opts.seed === 'number') {
      Random.Seed(opts.seed);
    }

    // this.UpdateMCDialog(0, 'Initializing', true);
    this.dialog?.ShowDialog({
      // progress_bar: true,
      // progress: 0,
      title: 'Running Monte Carlo simulation',
      message: 'Starting',
      // type: DialogType.info,
    }).then(() => {
      if (this.simulation_status.running && abort_on_dialog_close) {
        this.AbortSimulation();
      }
    });

    if (!this.workers.length) {
      try {
        await this.InitWorkers();
      }
      catch(err) {
        this.dialog?.ShowDialog({
          title: 'Calculation failed',
          message: 'Worker not initialized.',
          close_box: true,
          type: DialogType.error,
          timeout: 3000,
        });
        throw new Error('worker not initialized');
      }
    }

    if (!this.workers[0]) {
      this.dialog?.ShowDialog({
        title: 'Calculation failed',
        message: 'Worker not initialized.',
        close_box: true,
        type: DialogType.error,
        timeout: 3000,
      });
      throw new Error('worker not initialized');
    }

    /*
    if (stepped && this.workers.length > 1) {
      this.dialog?.ShowDialog({
        title: 'Calculation failed',
        message: 'Stepped simulation does support multiple workers.',
        close_box: true,
        type: DialogType.error,
        timeout: 3000,
      });
      throw new Error('invalid configiration');
    }
    */

    this.Publish({
      type: 'running-simulation',
      trials,
    });

    this.simulation_status.running = true;
    this.simulation_status.threads = this.workers.length;
    this.simulation_status.progress = [];
    this.simulation_status.results = [];
    this.simulation_status.aggregate_progress = 0;
    this.simulation_status.completed = 0;

    for (let i = 0; i < this.workers.length; i++) {
      this.simulation_status.progress.push(0);
    }

    // NOTE: accessing grid.cells, find a better approach [??]

    // let additional_cells =  this.additional_cells.slice(0);
    // let additional_cells: ICellAddress[] = [];

    // add any required additional collector cells from annotations (charts)

    for (const annotation of this.grid.active_sheet.annotations) {
      if (annotation.formula) {
        additional_cells = additional_cells.concat(
          this.calculator.MetadataReferences(annotation.formula));
      }
    }

    additional_cells = this.calculator.FlattenCellList(additional_cells);

    let macro_functions: MacroFunction[] | undefined;

    // when passing in macro functions, we have to be sure we don't try
    // to pass any bound expressions (closures) that get attached. we could
    // parse on the receiving side, but this saves that work... not sure it's
    // clean, though.

    // FIXME: if you're cloning, just clone the whole thing at once.

    if (this.grid.model.macro_functions) {
      macro_functions = [];
      const keys = Object.keys(this.grid.model.macro_functions);
      for (const key of keys) {
        const macro_function = this.grid.model.macro_functions[key];
        macro_functions.push(JSON.parse(JSON.stringify(macro_function)));
      }
    }

    let named_expressions: SerializedNamedExpression[] | undefined;
    if (this.grid.model.named_expressions) {
      const expresssions: SerializedNamedExpression[] = [];
      for (const name of Object.keys(this.grid.model.named_expressions)) {
        const expr = this.grid.model.named_expressions[name];
        const rendered = this.parser.Render(expr, undefined, '');
        expresssions.push({ name, expression: rendered });
      }
      if (expresssions.length) {
        named_expressions = expresssions;
      }
    }

    // hold state for replay, but watch out if it's not the same size

    const seed_buffer: number[] = this.workers.map(() => Random.Next() * 1e14);
    if (opts.replay) {
      this.replay_buffer.map((x, i) => seed_buffer[i] = x);
    }

    for (let i = 0; i < this.workers.length; i++) {
      this.workers[i].postMessage({
        type: 'configure',
        seed: seed_buffer[i], // : Math.round(Random.Next() * 1e14),
        locale: Localization.locale,
        sheets: this.grid.model.sheets.map((sheet) => {
          return sheet.toJSON({
            rendered_values: true, // has a different name, for some reason
            preserve_type: true,
          });
        }),
        named_ranges: this.grid.model.named_ranges.Serialize(),
        macro_functions,
        named_expressions,
        additional_cells,
      });
    }

    this.replay_buffer = seed_buffer;

    // NOTE: we want to set our local seed as well, otherwise calculated
    // values on update look different on replay. that's not a technical
    // problem but it does tend to violate user expectation.

    // we can work around that by using the first generated seed locally.
    // this will either be random, or the cached value.

    Random.Seed(seed_buffer[0]);
    
    // const per_thread = Math.floor(trials / this.workers.length);
    // const last_thread = trials - (per_thread * (this.workers.length - 1));
    // console.info('per', per_thread, 'last', last_thread);

    // new algo for splitting trials. this is WAY over-optimizing. 
    // (but that uneven split was irritating).

    let remaining = trials;
    let count = this.workers.length;

    for (const worker of this.workers) {

      const trials = Math.floor(remaining/count--);

      worker.postMessage({
        type: 'start', 
        trials,
        // trials: worker === this.workers[0] ? last_thread : per_thread, 
        lhs,
        screen_updates: stepped,
      });

      remaining -= trials;

    }

    await new Promise((resolve) => {
      this.simulation_resolution.push(resolve);
    });

  }

  /** override event type */
  public Subscribe(subscriber: ((event: CompositeEmbeddedSheetEvent) => void) | ((event: EmbeddedSheetEvent) => void)): number {
    return this.events.Subscribe(subscriber as (event: {type: string}) => void);
  }

  /** override event type */
  protected Publish(event: CompositeEmbeddedSheetEvent) {
    this.events.Publish(event);
  }

  protected FlushSimulationResults(): void {
    this.calculator.FlushSimulationResults();
  }

  /**
   * init workers. we have a separate method so we can warm start
   * on load, if desired. also you can re-init... 
   * 
   * FIXME: should globalize these? if we do that, the "running" flag
   * needs to be similarly global...
   */
  protected async InitWorkers(max = this.options.max_workers): Promise<void> {

    max = max || 1; // could be undefined? (...)

    if (this.workers.length) {
      for (const worker of this.workers) {
        worker.terminate();
      }
      this.workers = [];
    }

    const worker_name = process.env.BUILD_ENTRY_CALCULATION_WORKER || '';

    // we were hard-limiting workers to the hardware consistency value, but
    // that (apparently) is not available in Safari, so... just allow the 
    // user to do what they want.

    // FIXME: should warn about this? (...)

    let thread_count = Math.max(1, max);
    if (typeof navigator.hardwareConcurrency === 'number') {
      thread_count = Math.min(thread_count, navigator.hardwareConcurrency);
    }

    // const thread_count = Math.min(navigator.hardwareConcurrency || 1, max);

    console.info(`creating ${thread_count} thread${thread_count === 1 ? '' : 's'}`);

    for (let i = 0; i < thread_count; i++) {

      this.workers[i] = await this.LoadWorker(worker_name);

      this.workers[i].onmessage = (event) => {
        const message = event.data as WorkerMessage;
        this.HandleWorkerMessage(message, i);
      };

      this.workers[i].onerror = (event) => {
        console.error(`worker error (worker #${i})`);
        console.info(event);

        const message = event.message || 'Worker error.';

        this.dialog?.ShowDialog({
          title: 'Calculation failed',
          message,
          close_box: true,
          type: DialogType.error,
          timeout: 3000,
        });

        // flush
        for (const entry of this.simulation_resolution) {
          entry.call(this);
        }
        this.simulation_resolution = [];
        this.simulation_status.running = false;
        for (const worker of this.workers) {
          worker.terminate();
        }
        this.workers = [];

      };

    }

  }

  /**
   * overload for MC calculator replaces base calculator
   */
  protected InitCalculator(): Calculator {
    return new MCCalculator(this.model);
  }

  protected ImportDocumentData(data: TREBDocument, override_sheet?: string): void {

    super.ImportDocumentData(data, override_sheet);

    if (data.simulation_data) {
      this.calculator.UnserializeSimulationData(data.simulation_data);
    }
    else {
      this.FlushSimulationResults();
    }

  }

  /**
   * splitting into a separate method to remove code duplication
   */
   protected UpdateProgress(value: number, index: number): void {

    this.simulation_status.progress[index] = value || 0;

    const progress = Math.round(
      this.simulation_status.progress.reduce((a, b) => a + b, 0) / this.simulation_status.threads);
    
    if (progress !== this.simulation_status.aggregate_progress) {
      this.simulation_status.aggregate_progress = progress;            
      // this.UpdateMCDialog(progress);

      this.dialog?.Update({
        message: `${progress}% complete`,
      });
 

      this.Publish({type: 'simulation-progress', progress});
    }

  }

  /**
   * rx handler for worker messages
   */
  protected HandleWorkerMessage(message: WorkerMessage, index: number): void {

    switch (message.type) {
      case 'update':

        // throw new Error('not implemented for multithread (atm)');

        /** temp
        this.UpdateMCDialog(Number(message.percent_complete || 0));
        this.last_simulation_data = message.trial_data;
        this.calculator.UpdateResults(message.trial_data);
        this.Recalculate();

        // not actually possible for this not to exist at this
        // point -- is there a way to express that in ts?

        if (this.workers[index]) this.workers[index].postMessage({ type: 'step' });
        temp **/

        this.UpdateProgress(message.percent_complete, index);
        this.simulation_status.results[index] = message.trial_data;

        this.calculator.last_simulation_data =
          PackResults.ConsolidateResults(this.simulation_status.results.filter(test => !!test));

        // this.calculator.UpdateResults(this.calculator.last_simulation_data);
        this.calculator.UpdateResults();

        this.Recalculate().then(() => {
          this.workers[index].postMessage({ type: 'step' });
          // if(!this.grid.headless) { this.Focus() }
        });          

        break;

      case 'progress':
        this.UpdateProgress(message.percent_complete, index);
        break;

      case 'complete':
        this.simulation_status.progress[index] = 100;

        // this was a handy way of checking if all results are in; but it 
        // breaks if we are using "stepped simulation", because we need
        // to populate the array ahead of time. note also that array methods
        // (e.g. "every", "some") won't work because they will skip empty
        // values. so we'll use an explicit counter, which is overkill but
        // will work well. (although you could use reduce to count...)
        //
        // actually using the explicit counter is probably the best way if 
        // you want to support multi-worker "stepped", which is silly

        // this.simulation_status.results.push(message.trial_data);
        this.simulation_status.results[index] = message.trial_data;
        this.simulation_status.completed++;

        if (this.simulation_status.completed === this.simulation_status.threads) {

          this.simulation_status.running = false;
          this.calculator.last_simulation_data =
            PackResults.ConsolidateResults(this.simulation_status.results);

          requestAnimationFrame(() => {
            //this.calculator.UpdateResults(this.calculator.last_simulation_data);
            this.calculator.UpdateResults();
            
            this.Recalculate().then(() => {
              if(!this.grid.headless) { this.Focus() }
            });

            setTimeout(() => {
              this.dialog?.HideDialog();
              this.Publish({ 
                type: 'simulation-complete',
                elapsed: this.calculator.last_simulation_data?.elapsed || 0,
                trials: this.calculator.last_simulation_data?.trials || 0,
                // threads: this.simulation_status.threads,
              });

              for (const entry of this.simulation_resolution) {
                entry.call(this);
              }
              this.simulation_resolution = [];

            }, 500); // 500ms? is this waiting for something?
          });
        }
        else {
          this.UpdateProgress(100, index);
        }
        break;

      default:
        console.info('unhandled worker message', message);
        break;

    }

  }

  protected AbortSimulation(): void {

    console.warn('aborting simulation');

    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];

    // FIXME: unify code w/ above

    this.simulation_status.running = false;
    // this.last_simulation_data =
    //  PackResults.ConsolidateResults(this.simulation_status.results);

    requestAnimationFrame(() => {
      //this.calculator.UpdateResults(this.last_simulation_data);
      this.Recalculate().then(() => {
        if(!this.grid.headless) { this.Focus() }
      });

      this.Publish({ type: 'simulation-aborted' });

      for (const entry of this.simulation_resolution) {
        entry.call(this);
      }
      this.simulation_resolution = [];

    });

  }


}
