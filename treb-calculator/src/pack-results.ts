
/**
 * results looks like this:
 * Array<{row: number, column: number, data: any[]}>
 *
 * where the array length is the number of trials. assuming
 * we only handle numbers, we should be able to pack this into
 * an array.
 */

export interface Result {
  row: number;
  column: number;
  data: number[];
}

export const PackOne = (result: Result) => {
  const size = 3 + result.data.length;
  const data = new Float64Array(size);
  data[0] = result.column;
  data[1] = result.row;
  data[2] = result.data.length;
  data.set(result.data, 3);
  return data;
};

export const UnpackOne = (data: Float64Array) => {
  return { column: data[0], row: data[1], data: data.subarray(3) };
};

