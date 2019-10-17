import {TextPart} from 'treb-base-types';

/**
 * essentially number formats have a core section with the number
 * (possibly scaled), and some representation before and after.
 * exponential and percentage notation scale the number. exponential
 * is only allowed after the number. percent can come before or after.
 *
 * converting to class, default values
 */
export class NumberFormatSection {

  /** flag: this is a date format */
  public date_format = false;

  /** flag: this is the string section, don't format numbers */
  public string_format = false;

  /** flag: time in 12-hour format  */
  public twelve_hour = false;

  /** prepend zeros */
  public integer_min_digits = 0;

  /** append zeros */
  public decimal_min_digits = 0;

  /** append decimal digits, but not trailing zeros */
  public decimal_max_digits = 0;

  /** use grouping (only supports groups of 3, no matter where you put the ,) */
  public grouping = false;

  /** this is a flag for switching whether we append strings to prefix or suffix */
  public has_number_format = false;

  /** leading string(s) */
  public prefix: TextPart[] = [{ text: '' }];

  /** trailing string(s) */
  public suffix: TextPart[] = [{ text: '' }];

  /**
   * thousands scaling (trailing commas in the number format section). we set
   * to zero for a faster flag if no scaling.
   */
  public scaling = 0;

  /** flag indicating percent -- will multiply value by 100 */
  public percent = false;

  /** flag indicating exponential -- turns numbers in to exp format */
  public exponential = false;

  /** this is a flag for testing -- we don't support multiple * in a format */
  public has_asterisk = false;

}
