
import { EmbeddedSpreadsheet } from './embedded-spreadsheet';
import { AutoEmbed } from './auto-embed';
import { CreateSheetOptions } from './options';

import * as build from '@root/package.json';

// create (or attach to) global TREB namespace

(() => {
  if (!(self as any).TREB) { (self as any).TREB = {}; }
  const TREB: any = (self as any).TREB;
  TREB.CreateSpreadsheet = (options: CreateSheetOptions) => AutoEmbed.CreateSheet(options);
  TREB['treb-embed'] = { version: (build as any).version };
})();

// find path for worker loaders

EmbeddedSpreadsheet.SniffPath();

// FIXME: what if it's already loaded? (...)

document.addEventListener('DOMContentLoaded', () => AutoEmbed.Run());

// re-export

export { EmbeddedSpreadsheet } from './embedded-spreadsheet';
