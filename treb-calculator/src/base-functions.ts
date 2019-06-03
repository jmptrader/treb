
import { FunctionLibrary } from './function-library';
import * as Utils from './utilities';
import { Localization } from 'treb-base-types';
import { NumberFormatCache } from 'treb-format';

/**
 * this module populates spreadsheet functions, which are objects stored
 * in the library instance. as such, it's imported for side-effects and not
 * any exports (so use the explicit import '' syntax).
 *
 * FIXME: there's no reason this has to be a single, monolithic file. we
 * could split up into block sections by category or something.
 *
 * ALSO: add category to descriptor.
 */

/** milliseconds in one day, used in time functions */
const DAY_MS = 1000 * 60 * 60 * 24;

// some functions have semantics that can't be represented inline,
// or we may want to refer to them from other functions.

/** error function (for gaussian distribution) */
const erf = (x: number) => {

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  x = Math.abs(x);
  const t = 1 / (1 + p * x);
  return 1 - ((((((a5 * t + a4) * t) + a3) * t + a2) * t) + a1) * t * Math.exp(-1 * x * x);

};

// --- create and register functions -------------------------------------------

FunctionLibrary.Register({

  IsError: {
    description: 'Checks if another cell contains an error',
    arguments: [{ name: 'reference' }],
    allow_error: [0],
    fn: (ref: any) => {
      return (!!ref && !!ref.error);
    },
  },

  IfError: {
    description: 'Returns the original value, or the alternate value if the original value contains an error',
    arguments: [{ name: 'original value' }, { name: 'alternate value' }],
    allow_error: [0],
    fn: (ref: any, value_if_error: any) => {
      if (!!ref && !!ref.error) return value_if_error;
      return ref;
    },
  },

  Now: {
    description: 'Returns current time',
    volatile: true,
    fn: () => {
      // NOTE: these are R dates. we should not use R dates. switch to unix timestamps.
      return new Date().getTime() / DAY_MS;
    },
  },

  Today: {
    description: 'Returns current day',
    fn: () => {
      // NOTE: these are R dates. we should not use R dates. switch to unix timestamps.
      const date = new Date();
      date.setMilliseconds(0);
      date.setSeconds(0);
      date.setMinutes(0);
      date.setHours(12);
      return date.getTime() / DAY_MS;
    },
  },

  Year: {
    description: 'Returns current year',
    fn: (r_date: number) => {
      // NOTE: these are R dates. we should not use R dates. switch to unix timestamps.
      const date = new Date(r_date * DAY_MS);
      return date.getUTCFullYear();
    },
  },

  Radians: {
    description: 'Converts degrees to radians',
    arguments: [{ name: 'Degrees', description: 'Angle in degrees' }],
    fn: (degrees: number) => {
      return degrees * Math.PI / 180;
    },
  },

  Degrees: {
    description: 'Converts radians to degrees',
    arguments: [{ name: 'Radians', description: 'Angle in radians' }],
    fn: (radians: number) => {
      return radians / Math.PI * 180;
    },
  },

  Concatenate: {
    description: 'Pastes strings together',
    fn: (...args: any[]) => {
      return args.map((arg) => {

        if (typeof arg === 'number' && Localization.decimal_separator === ',') {
          return arg.toString().replace(/\./, ',');
        }
        return arg.toString();
      }).join('');
    },
  },

  Count: {
    description: 'Counts cells that contain numbers',
    fn: (...args: any[]) => {
      return Utils.Flatten(args).reduce((a: number, b: any) => {
        if (typeof b === 'number') return a + 1;
        return a;
      }, 0);
    },
  },

  Or: {
    fn: (...args: any[]) => {
      let result = false;
      for (const arg of args) {
        result = result || !!arg;
      }
      return result;
    },
  },

  And: {
    fn: (...args: any[]) => {
      let result = true;
      for (const arg of args) {
        result = result && !!arg;
      }
      return result;
    },
  },

  If: {
    fn: (a: any, b: any = true, c: any = false) => {
      if (a instanceof Float64Array || a instanceof Float32Array) a = Array.from(a);
      if (Array.isArray(a)) {
        return a.map((x) => {
          if ((typeof x === 'string') && (x.toLowerCase() === 'f' || x.toLowerCase() === 'false')) x = false;
          else x = Boolean(x);
          return x ? b : c;
        });
      }
      if ((typeof a === 'string') && (a.toLowerCase() === 'f' || a.toLowerCase() === 'false')) a = false;
      else a = Boolean(a);
      return a ? b : c;
    },
  },

  Mod: {
    fn: (num: number, divisor: number) => {
      return num % divisor;
    },
  },

  Sum: {
    description: 'Adds arguments and ranges',
    fn: (...args: any[]) => {
      return Utils.Flatten(args).reduce((a: number, b: any) => {
        if (typeof b === 'undefined') return a;
        return a + Number(b);
      }, 0);
    },
  },

  SumProduct: {
    description: 'Returns the sum of pairwise products of two or more ranges',
    fn: (...args: any[]) => {
      // if (args.length < 2) return { error: 'VALUE' };
      // if (args.length === 0) return 0;
      // if (args.length === 1) return args[0];

      const cols = args[0].length;
      const rows = args[0][0].length;
      if (!rows) return { error: 'RANGE' };

      let sum = 0;
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          sum += args.reduce((a, arg, index) => {
            return a * arg[c][r];
          }, 1);
        }
      }

      return sum;
    },
  },

  VLookup: {
    fn: (value: any, table: any[][], col: number, exact = false) => {

      col = Math.max(0, col - 1);

      let min = Math.abs(value - table[0][0]);
      let result: any = table[col][0];

      for (let i = 1; i < table[0].length; i++) {
        const abs = Math.abs(table[0][i] - value);
        if (abs < min) {
          min = abs;
          result = table[col][i];
        }
      }

      return result;
    },
  },

  Product: {
    fn: (...args: any[]) => {
      return Utils.Flatten(args).reduce((a: number, b: any) => {
        if (typeof b === 'undefined') return a;
        return a * Number(b);
      }, 1);
    },
  },

  Max: {
    fn: (...args: any[]) => {
      return Math.max.apply(0, Utils.Flatten(args));
    },
  },

  Min: {
    fn: (...args: any[]) => {
      return Math.min.apply(0, Utils.Flatten(args));
    },
  },

  Log: {
    /** default is base 10; allow specific base */
    fn: (a: number, base?: number) => {
      if (typeof base !== 'undefined') return Math.log(a) / Math.log(base);
      return Math.log10(a);
    },
  },

  Ln: {
    fn: (a: number) => {
      return Math.log(a);
    },
  },

  RandBetween: {
    arguments: [{name: 'min'}, {name: 'max'}],
    fn: (min: number, max: number) => {
      return Math.random() * (max - min) + min;
    },
  },

  Round: {
    description: 'Round to a specified number of digits',

    /** round with variable digits */
    fn: (value: number, digits = 0) => {
      const m = Math.pow(10, digits);
      return Math.round(m * value) / m;
    },
  },

  RoundDown: {
    /** round down with variable digits */
    fn: (value: number, digits = 0) => {
      digits = Math.max(0, digits);
      const m = Math.pow(10, digits);
      return Math.floor(m * value) / m;
    },
  },

  Average: {
    fn: (...args: any[]) => {
      args = Utils.Flatten(args);
      return args.reduce((a: number, b: any) => {
        if (typeof b === 'undefined') return a;
        return a + Number(b);
      }, 0) / args.length;
    },
  },

  Sort: {
    fn: (...args: any[]) => {
      args = Utils.Flatten(args);
      const numeric = args.every((x) => {
        const type = typeof x;
        return (null === x || type === 'undefined' || type === 'number');
      });
      return numeric ? args.sort((a, b) => a - b) : args.sort();
    },
  },

  Transpose: {
    description: 'Returns transpose of input matrix',
    arguments: [{name: 'matrix'}],
    fn: Utils.TransposeArray,
  },

  Reverse: {
    fn: (a: any) => {
      if ( Array.isArray(a)) {
        if (a.length === 1 ) return [a[0].reverse()];
        return a.reverse();
      }
      return a.toString().split('').reverse().join('');
    },
  },

  Abs: {
    fn: Utils.ApplyArrayFunc(Math.abs),
  },

  Text: {
    fn: (value: number, format?: string) => {
      if (!format || typeof format !== 'string') {
        format = '0.00####';
      }
      return NumberFormatCache.Get(format).Format(value || 0);
    },
  },

  Simplify: {
    fn: (value: number, significant_digits = 2) => {
      significant_digits = significant_digits || 2;
      if (value === 0) return value;
      const negative = value < 0 ? -1 : 1;
      value *= negative;
      const x = Math.pow(10, Math.floor(Math.log10(value)) + 1 - significant_digits);
      return Math.round(value / x) * x * negative;
    },
  },

  Erf: {
    fn: erf,
  },

  'Norm.Dist': {

    description: 'Cumulative normal distribution',
    arguments: [
      {name: 'value'},
      {name: 'mean', default: 0},
      {name: 'standard deviation', default: 1},
    ],

    fn: (x: number, mean = 0, stdev = 1) => {

      // generalized
      const sign = (x < mean) ? -1 : 1;
      return 0.5 * (1.0 + sign * erf((Math.abs(x - mean)) / (stdev * Math.sqrt(2))));

    },
  },

});

// --- create and register all functions from Math -----------------------------

// FIXME: manually curate

for (const name of Object.getOwnPropertyNames(Math)) {

  // check if it exists (we have already registered something
  // with the same name) -- don't override existing

  const test = FunctionLibrary.Get(name);
  if (test) {
    continue;
  }

  const desc = Object.getOwnPropertyDescriptor(Math, name);
  if (!desc) {
    continue;
  }

  const value = desc.value;
  const type = typeof(value);

  if (type === 'number'){
    FunctionLibrary.Register({[name]: {fn: () => value}});
  }
  else if (type === 'function'){
    FunctionLibrary.Register({[name]: {fn: value}});
  }
  else {
    console.info('unexpected type:', type, name);
  }

}

// --- aliases -----------------------------------------------------------------

FunctionLibrary.Alias('Mean', 'Average');

