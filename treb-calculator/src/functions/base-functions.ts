
import { FunctionMap } from '../descriptors';
import * as Utils from '../utilities';
import { ReferenceError, NotImplError, NAError, ArgumentError, DivideByZeroError } from '../function-error';
import { Box, UnionOrArray, UnionIs, UnionValue, ValueType, GetValueType, RenderFunctionResult } from 'treb-base-types';
import { Sparkline, SparklineRenderOptions } from './sparkline';
import { LotusDate, UnlotusDate } from 'treb-format';

import { ClickCheckbox, RenderCheckbox } from './checkbox';
import { UnionIsMetadata } from '../expression-calculator';

import { ClickHyperlink, RenderHyperlink } from './hyperlink';

/**
 * BaseFunctionLibrary is a static object that has basic spreadsheet
 * functions and associated metadata (there's also a list of aliases).
 *
 * Calculator should register this one first, followed by any other
 * application-specific libraries.
 *
 * FIXME: there's no reason this has to be a single, monolithic library.
 * we could split up by category or something.
 *
 * ALSO: add category to descriptor.
 */

/** milliseconds in one day, used in time functions */
// const DAY_MS = 1000 * 60 * 60 * 24;

// some functions have semantics that can't be represented inline,
// or we may want to refer to them from other functions.

// OK, just one.

/** error function (for gaussian distribution) */
const erf = (x: number): number => {

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

const UnionTrue = { type: ValueType.boolean, value: true };
const UnionFalse = { type: ValueType.boolean, value: false };

// use a single, static object for base functions

export const BaseFunctionLibrary: FunctionMap = {


  Rand: {
    volatile: true,
    fn: (): UnionOrArray => { return { type: ValueType.number, value: Math.random() }},
  },

  RandBetween: {
    arguments: [{name: 'min'}, {name: 'max'}],
    volatile: true,
    fn: (min = 0, max = 1): UnionOrArray => { 
      if (min > max) { 
        const tmp = min;
        min = max;
        max = tmp;
      }
      return { type: ValueType.number, value: Math.random() * (max - min) + min }
    },
  },

  Sum: {
    description: 'Adds arguments and ranges',
    arguments: [{ boxed: true, name: 'values or ranges' }],
    fn: (...args: UnionValue[]): UnionOrArray => {

      let sum = 0;
      const values = Utils.Flatten(args) as UnionValue[];

      for (const value of values) {
        switch (value.type) {
          case ValueType.number: sum += value.value; break;
          case ValueType.boolean: sum += (value.value ? 1 : 0); break;
          case ValueType.error: return value;
        }
      }

      return { type: ValueType.number, value:sum };

    },
  },

  Now: {
    description: 'Returns current time',
    volatile: true,
    fn: (): UnionOrArray => {
      return { type: ValueType.number, value: UnlotusDate(new Date().getTime()) };
    },
  },

  Today: {
    description: 'Returns current day',
    volatile: true,
    fn: (): UnionOrArray => {
      const date = new Date();
      date.setMilliseconds(0);
      date.setSeconds(0);
      date.setMinutes(0);
      date.setHours(12);
      return { type: ValueType.number, value: UnlotusDate(date.getTime()) };
    },
  },

  IfError: {
    description: 'Returns the original value, or the alternate value if the original value contains an error',
    arguments: [{ name: 'original value', allow_error: true, boxed: true }, { name: 'alternate value' }],
    fn: (ref: UnionValue, value_if_error: unknown = 0): UnionValue => {
      if (ref && ref.type === ValueType.error) {
        return { value: value_if_error, type: GetValueType(value_if_error) };
      }
      return ref;
    },
  },

  IsError: {
    description: 'Checks if another cell contains an error',
    arguments: [{ name: 'reference', allow_error: true, boxed: true }],
    fn: (ref: UnionOrArray): UnionOrArray => {

      if (Array.isArray(ref)) {
        const values = Utils.Flatten(ref) as UnionValue[];
        for (const value of values) {
          if (value.type === ValueType.error) {
            return { type: ValueType.boolean, value: true };
          }
        }
      }
      else if (ref) {
        return { type: ValueType.boolean, value: ref.type === ValueType.error };
      }

      return { type: ValueType.boolean, value: false };

    },
  },


    Cell: {
      description: 'Returns data about a cell',
      arguments: [
        { name: 'type', description: 'Type of data to return' },
        { name: 'reference', description: 'Cell reference', metadata: true },
      ],

      // there's no concept of "structure volatile", and structure events
      // don't trigger recalc, so this is not helpful -- we may need to 
      // think about both of those things
      
      // volatile: true, 

      fn: (type: string, reference: UnionValue): UnionValue => {

        if (!UnionIsMetadata(reference)) {
          return ReferenceError();
        }

        if (type) {
          switch (type.toString().toLowerCase()) {
            case 'format':
              return reference.value.format ? // || ReferenceError;
                { type: ValueType.string, value: reference.value.format } : ReferenceError();
            case 'address':
              return { type: ValueType.string, value: reference.value.address.label.replace(/\$/g, '') };
          }
        }

        return { type: ValueType.error, value: NotImplError.error };

      },
    },

    Year: {
      description: 'Returns year from date',
      arguments: [{
        name: 'date',
      }],
      fn: (source: number): UnionValue => {
        return Box(new Date(LotusDate(source)).getUTCFullYear());
      },
    },


    Month: {
      description: 'Returns month from date',
      arguments: [{
        name: 'date',
      }],
      fn: (source: number): UnionValue => {
        return Box(new Date(LotusDate(source)).getUTCMonth() + 1); // 0-based
      },
    },

    
    Day: {
      description: 'Returns day of month from date',
      arguments: [{
        name: 'date',
      }],
      fn: (source: number): UnionValue => {
        return Box(new Date(LotusDate(source)).getUTCDate());
      },
    },

    Radians: {
      description: 'Converts degrees to radians',
      arguments: [{ name: 'Degrees', description: 'Angle in degrees' }],
      fn: Utils.ApplyAsArray((degrees: number): UnionValue => {
        return Box(degrees * Math.PI / 180);
      }),
    },

    Degrees: {
      description: 'Converts radians to degrees',
      arguments: [{ name: 'Radians', description: 'Angle in radians' }],
      fn: Utils.ApplyAsArray((radians: number): UnionValue => {
        return Box(radians / Math.PI * 180);
      }),
    },

    CountA: {
      description: 'Counts cells that are not empty',
      fn: (...args: unknown[]): UnionValue => {
        return Box(Utils.Flatten(args).reduce((a: number, b: unknown) => {
          if (typeof b === 'undefined') return a;
          return a + 1;
        }, 0));
      },
    },

    Count: {
      description: 'Counts cells that contain numbers',
      fn: (...args: unknown[]): UnionValue => {
        return Box(Utils.Flatten(args).reduce((a: number, b: unknown) => {
          if (typeof b === 'number') return a + 1;
          return a;
        }, 0));
      },
    },

    Or: {
      fn: (...args: unknown[]): UnionValue => {
        let result = false;
        args = Utils.Flatten(args);
        for (const arg of args) {
          result = result || !!arg;
        }
        return Box(result);
      },
    },

    And: {
      fn: (...args: unknown[]): UnionValue => {
        let result = true;
        args = Utils.Flatten(args);
        for (const arg of args) {
          result = result && !!arg;
        }
        return Box(result);
      },
    },

    Not: {
      fn: (...args: unknown[]): UnionValue => {
        if (args.length === 0) {
          return ArgumentError();
        }
        if (args.length === 1) {
          return Box(!args[0]);
        }
        return Box(true);
      }
    },

    If: {
      arguments: [
        { name: 'test value', boxed: true },
        { name: 'value if true', boxed: true, allow_error: true },
        { name: 'value if false', boxed: true, allow_error: true },
      ],
      fn: (a: UnionOrArray, b: UnionOrArray = UnionTrue, c: UnionOrArray = UnionFalse): UnionOrArray => {

        if (Array.isArray(a)) {
          return a.map((row, x) => row.map((cell, y) => {
            const value = UnionIs.String(cell) ? 
              (cell.value.toLowerCase() !== 'false' && cell.value.toLowerCase() !== 'f') : !!cell.value;
            return value ? (Array.isArray(b) ? b[x][y] : b) : (Array.isArray(c) ? c[x][y]: c);
          }));
        }

        const value = UnionIs.String(a) ? 
          (a.value.toLowerCase() !== 'false' && a.value.toLowerCase() !== 'f') : !!a.value;

        return value ? b : c;

      },
    },

    Power: {
      fn: Utils.ApplyAsArray2((base: number, exponent: number): UnionValue => Box(Math.pow(base, exponent))),
    },

    Mod: {
      fn: Utils.ApplyAsArray2((num: number, divisor: number): UnionValue => {
        if (!divisor) { 
          return DivideByZeroError();
        }
        return Box(num % divisor);
      })
    },

    /**
     * sort arguments, but ensure we return empty strings to
     * fill up the result array
     */
    Sort: {
      arguments: [
        { name: 'values' }
      ],
      fn: (...args: any[]): UnionValue[][] => {

        args = Utils.Flatten(args);

        if(args.every(test => typeof test === 'number')) {
          args.sort((a, b) => a - b);
        }
        else {
          args.sort(); // lexical
        }

        return [args.map(value => Box(value))];

      },
    },

    Transpose: {
      description: 'Returns transpose of input matrix',
      arguments: [{name: 'matrix', boxed: true}],
      fn: (mat: UnionOrArray): UnionOrArray => {
        if (Array.isArray(mat)) {
          return Utils.Transpose2(mat);
        }
        return mat;
      } 
    },

    Max: {
      fn: (...args: any[]): UnionValue => {
        return { 
          type: ValueType.number, 
          value: Math.max.apply(0, Utils.Flatten(args).filter(x => typeof x === 'number')),
        };
      },
    },

    Min: {
      fn: (...args: any[]): UnionValue => {
        return { 
          type: ValueType.number, 
          value: Math.min.apply(0, Utils.Flatten(args).filter(x => typeof x === 'number')),
        };
      },
    },


    /*
    MMult: {
      description: 'Multiplies two matrices',
      arguments: [{ name: 'Matrix 1'}, { name: 'Matrix 2'}],
      fn: (a, b) => {
        if (!a || !b) return ArgumentError;

        const a_cols = a.length || 0;
        const a_rows = a[0]?.length || 0;

        const b_cols = b.length || 0;
        const b_rows = b[0]?.length || 0;

        if (!a_rows || !b_rows || !a_cols || !b_cols
           || a_rows !== b_cols || a_cols !== b_rows) return ValueError;

        const result: number[][] = [];

        // slightly confusing because we're column-major

        for (let c = 0; c < b_cols; c++) {
          result[c] = [];
          for (let r = 0; r < a_rows; r++) {
            result[c][r] = 0;
            for (let x = 0; x < a_cols; x++) {
              result[c][r] += a[x][r] * b[c][x];
            }
          }
        }
        return result;

      }
    },
    */

    SumProduct: {
      description: 'Returns the sum of pairwise products of two or more ranges',
      fn: (...args: any[]): UnionValue  => {

        const flattened = args.map(arg => Utils.Flatten(arg));
        const len = Math.max.apply(0, flattened.map(x => x.length));

        let sum = 0;
        for (let i = 0; i < len; i++) {
          sum += flattened.reduce((a, arg) => {
            return a * (arg[i] || 0);
          }, 1);
        }        

        return { type: ValueType.number, value: sum };

      },
    },

    /**
     * FIXME: does not implement inexact matching (what's the algo for
     * that, anyway? nearest? price is right style? what about ties?)
     */
    VLookup: {
      fn: (value: any, table: any[][], col: number, inexact = true): UnionValue => {

        col = Math.max(0, col - 1);

        if (inexact) {

          let min = Math.abs(value - table[0][0]);
          let result: any = table[col][0];

          for (let i = 1; i < table[0].length; i++) {

            const abs = Math.abs(table[0][i] - value);

            if (abs < min) { // implies first match
              min = abs;
              result = table[col][i];
            }
          }

          return Box(result);

        }
        else {
          for (let i = 1; i < table[0].length; i++) {
            if (table[0][i] == value) { // ==
              return table[col][i];
            }
          }
          return NAError();
        }

      },
    },

    Product: {
      fn: (...args: any[]): UnionValue => {
        return { type: ValueType.number, value: Utils.Flatten(args).reduce((a: number, b: any) => {
          if (typeof b === 'undefined') return a;
          return a * Number(b);
        }, 1) };
      },
    },

    Log: {
      /** default is base 10; allow specific base */
      fn: Utils.ApplyAsArray2((a: number, base = 10): UnionValue => {
        return { type: ValueType.number, value: Math.log(a) / Math.log(base) };
      }),
    },

    Log10: {
      fn: Utils.ApplyAsArray((a: number): UnionValue => {
        return { type: ValueType.number, value: Math.log(a) / Math.log(10) };
      }),
    },

    Ln: {
      fn: Utils.ApplyAsArray((a: number): UnionValue => {
        return { type: ValueType.number, value: Math.log(a) };
      }),
    },

    Round: {
      fn: Utils.ApplyAsArray2((a, digits = 0) => {
        const m = Math.pow(10, digits);
        return { 
          type: ValueType.number, 
          value: Math.round(m * a) / m,
        };
      }),
    },

    RoundDown: {
      fn: Utils.ApplyAsArray2((a, digits = 0) => {
        const m = Math.pow(10, digits);
        const positive = a >= 0;
        return { 
          type: ValueType.number, 
          value: positive ? Math.floor(m * a) / m : Math.ceil(m * a) / m,
        };
      }),
    },

    /*

    Round: {
      description: 'Round to a specified number of digits',

      / ** round with variable digits * /
      fn: (value: number, digits = 0) => {
        const m = Math.pow(10, digits);
        return Math.round(m * value) / m;
      },
    },

    RoundDown: {
      / ** round down with variable digits * /
      fn: (value: number, digits = 0) => {
        digits = Math.max(0, digits);
        const m = Math.pow(10, digits);
        return Math.floor(m * value) / m;
      },
    },


    */


    Reverse: {
      arguments: [
        { boxed: true },
      ],
      fn: (a: UnionOrArray): UnionOrArray => {
        if ( Array.isArray(a)) {
          if (a.length === 1 ) return [a[0].reverse()];
          return a.reverse();
        }
        return { 
          type: ValueType.string, 
          value: a.value.toString().split('').reverse().join(''),
        };
      },
    },

    Abs: {
      fn: Utils.ApplyAsArray((a) => {
        return { type: ValueType.number, value: Math.abs(a) };
      }),
    },

    Simplify: {
      fn: Utils.ApplyAsArray2((value: number, significant_digits = 2): UnionValue => {
        significant_digits = significant_digits || 2;
        if (value === 0) {
          return { type: ValueType.number, value };
        }
        const negative = value < 0 ? -1 : 1;
        value *= negative;
        const x = Math.pow(10, Math.floor(Math.log10(value)) + 1 - significant_digits);
        return {
          type: ValueType.number,
          value: Math.round(value / x) * x * negative
        };
      }),
    },
 
    Erf: {
      fn: (a: number): UnionValue => {
        return { type: ValueType.number, value: erf(a) };
      },
    },

    'Norm.Dist': {

      description: 'Cumulative normal distribution',
      arguments: [
        {name: 'value'},
        {name: 'mean', default: 0},
        {name: 'standard deviation', default: 1},
      ],

      fn: (x: number, mean = 0, stdev = 1): UnionValue => {

        // generalized
        const sign = (x < mean) ? -1 : 1;
        return { 
          type: ValueType.number, 
          value: 0.5 * (1.0 + sign * erf((Math.abs(x - mean)) / (stdev * Math.sqrt(2)))),
        };

      },
    },

    HexToDec: {
      arguments: [{ description: 'hexadecimal string' }],
      fn: (hex: string): UnionValue => {
        return { type: ValueType.number, value: parseInt(hex, 16) };
      },
    },

    DecToHex: {
      arguments: [{ description: 'number' }],
      fn: (num: number): UnionValue => {
        return { type: ValueType.string, value: num.toString(16) };
      },
    },

    Hyperlink: {
      arguments: [
        { name: 'text' },
        { name: 'URL or reference' },
      ],
      click: ClickHyperlink,
      render: RenderHyperlink,
      fn: (text: string, reference: string): UnionValue => {
        return { 
          type: ValueType.string, 
          value: [text, reference],
        };
      },
    },

    Checkbox: {
      arguments: [
        { name: 'checked' },
      ],
      click: ClickCheckbox,
      render: RenderCheckbox,
      fn: (checked: boolean): UnionValue => {
        return { value: !!checked, type: ValueType.boolean, }
      },
    },

    'Sparkline.Column': {
      arguments: [
        {name: 'data' }, 
        {name: 'color'}, 
        {name: 'negative color'}],
      render: (options: SparklineRenderOptions): RenderFunctionResult => {
        Sparkline.RenderColumn(options.width, options.height, options.context, options.cell);
        return { handled: true }; // painted
      },
      fn: (...args: unknown[]): UnionValue => {
        return { type: ValueType.object, value: args };
      },
    },

    'Sparkline.Line': {
      arguments: [
        {name: 'data'}, 
        {name: 'color'},
        {name: 'line width'},
      ],
      render: (options: SparklineRenderOptions): RenderFunctionResult => {
        Sparkline.RenderLine(options.width, options.height, options.context, options.cell);
        return { handled: true }; // painted
      },
      fn: (...args: unknown[]): UnionValue => {
        return { type: ValueType.object, value: args };
      },
    }

};

// alias

// add functions from Math (intrinsic), unless the name overlaps
// with something already in there

// we need to construct a separate map to match icase (this is now
// even more useful since we have a separate section for aliases)

const name_map: {[index: string]: string} = {};

for (const key of Object.keys(BaseFunctionLibrary)) {
  name_map[key.toLowerCase()] = key;
}

for (const name of Object.getOwnPropertyNames(Math)) {

  // check if it exists (we have already registered something
  // with the same name) -- don't override existing

  if (name_map[name.toLowerCase()]) { continue; }

  const descriptor = Object.getOwnPropertyDescriptor(Math, name);
  if (!descriptor) { continue; }

  const value = descriptor.value;
  const type = typeof (value);

  switch (type) {
  case 'number':
    // console.info("MATH CONSTANT", name);
    BaseFunctionLibrary[name] = {
      fn: () => { 
        return { type: ValueType.number, value }
      },
      category: ['Math Functions'],
    };
    break;

  case 'function':
    // console.info("MATH FUNC", name);
    BaseFunctionLibrary[name] = {
      fn: (...args: any) => {
        return Box(value(...args));
      },
      category: ['Math Functions'],
    };
    break;

  default:
    console.info('unexpected type:', type, name);
    break;
  }

}

// IE11: patch log10 function // FIXME: is this necessary anymore?

if (!Math.log10) {
  Math.log10 = (a) => Math.log(a) / Math.log(10);
  /*
  BaseFunctionLibrary.log10 = {
    fn: (x) => Math.log(x) / Math.log(10),
    category: ['Math Functions'],
  };
  */
}
