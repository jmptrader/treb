
import { FunctionMap } from '../descriptors';
import { IsComplex, UnionOrArray, UnionValue, ValueType } from 'treb-base-types';
import * as Utils from '../utilities';
import { ArgumentError, ValueError } from '../function-error';
import { RectangularToPolar } from '../complex-math';

export const ComplexFunctionLibrary: FunctionMap = {

  IsComplex: {
    description: 'Returns true if the reference is a complex number',
    arguments: [{
      name: 'Reference',
      metadata: true,
    }],
    fn: Utils.ApplyAsArray((ref: UnionValue): UnionValue => {
      return { 
        type: ValueType.boolean, 
        value: ref?.value && IsComplex(ref.value.value),
      };
    }),
  },


  Real: {
    description: 'Returns the real part of a complex number',
    arguments: [
      { boxed: true },
    ],
    fn: Utils.ApplyAsArray((ref: UnionValue): UnionValue => {
      if (ref.type === ValueType.number) {
        return { ...ref };
      }
      if (ref.type === ValueType.complex) {
        return {
          type: ValueType.number,
          value: ref.value.real || 0,
        };
      }
      if (ref.type === ValueType.undefined || (ref.type === ValueType.string && ref.value === '')) {
        return {
          type: ValueType.number,
          value: 0,
        };
      }
      return ValueError();
    }),
  },

  Imaginary: {
    description: 'Returns the imaginary part of a complex number (as real)',
    arguments: [
      { boxed: true },
    ],
    fn: Utils.ApplyAsArray((ref: UnionValue): UnionValue => {
      if (ref.type === ValueType.complex) {
        return {
          type: ValueType.number,
          value: ref.value.imaginary || 0,
        };
      }
      if (ref.type === ValueType.number ||
          ref.type === ValueType.undefined || 
          (ref.type === ValueType.string && ref.value === '')) {
        return {
          type: ValueType.number,
          value: 0,
        };
      }
      return ValueError();
    }),
  },

  Conjugate: {
    description: 'Returns the conjugate of a complex number',
    arguments: [
      { boxed: true },
    ],
    fn: Utils.ApplyAsArray((arg: UnionValue): UnionValue => {
      if (arg.type === ValueType.complex) {
        return {
          type: ValueType.complex,
          value: {
            real: arg.value.real,
            imaginary: -arg.value.imaginary,
          },
        };
      }
      else if (arg.type === ValueType.number || arg.type === ValueType.undefined || !arg.value) {
        return {
          type: ValueType.number, value: arg.value || 0,
        };
      }
      else {
        return ValueError();
      }
    }),
  },

  Arg: {
    description: 'Returns the principal argument of a complex number',
    arguments: [
      { boxed: true },
    ],
    fn: Utils.ApplyAsArray((ref: UnionValue): UnionValue => {
      
      if (ref.type === ValueType.complex) {
        return {
          type: ValueType.number,
          value: Math.atan2(ref.value.imaginary, ref.value.real),
        }
      }

      if (ref.type === ValueType.number ||
          ref.type === ValueType.undefined || 
          (ref.type === ValueType.string && ref.value === '')) {
        return {
          type: ValueType.number,
          value: Math.atan2(0, ref.value || 0),
        }
      }

      return ValueError();
    }),
  },

  Rectangular: {
    description: 'Converts a complex number in polar form to rectangular form',
    arguments: [
      { name: 'r' },
      { name: 'θ in radians' },
    ],
    fn: (r = 0, theta = 0): UnionValue => {
      return {
        type: ValueType.complex,
        value: { 
          real: r * Math.cos(theta),
          imaginary: r * Math.sin(theta),
        },
      }
    },
  },

  Complex: {
    description: 'Ensures that the given value will be treated as a complex number',
    arguments: [
      { boxed: true },
    ],

    // FIXME: this should use flatten? not sure

    fn: Utils.ApplyAsArray((a: UnionValue): UnionValue => {
      
      if (a.type === ValueType.complex) {
        return a;
      }
      
      if (a.type === ValueType.number || a.type === ValueType.undefined || !a.value) {
        return { 
          type: ValueType.complex, 
          value: {
            imaginary: 0,
            real: a.value || 0,
          },
        }
      }

      return ValueError();

    }),
  },

  /**
   * unfortunately we can't override the log function because the complex
   * log function has a different meaning even when applied to reals, i.e.
   * Log(a + 0i) !== ln(a)
   * 
   * note that Log(0) is undefined -- we need to return an error here, but
   * what error? let's do #VALUE
   * 
   */
  ComplexLog: {
    description: 'Returns the principal value Log(z) of a complex number z',
    arguments: [
      { boxed: true },
    ],
    fn: Utils.ApplyAsArray((a: UnionValue): UnionValue => {

      // real -> complex
      if (a.type === ValueType.number) {

        if (!a.value) {
          return ValueError();
        }

        a = {
          type: ValueType.complex,
          value: {
            real: a.value,
            imaginary: 0,
          },
        };
      }

      // other zero -> complex
      else if (a.type === ValueType.undefined || (a.type === ValueType.string && a.value === '')) {
        return ValueError();
      }

      if (a.type === ValueType.complex) {

        // from polar form, the principal value is 
        // Log z = ln r + iθ

        const polar = RectangularToPolar(a.value);
        const value = {
          real: Math.log(polar.r),
          imaginary: polar.theta,
        };

        return (value.imaginary) ?
          { type: ValueType.complex, value } :
          { type: ValueType.number, value: value.real };

      }
      
      return ValueError();

    }),
  },

};

