
import { Chart } from './';

if (!(self as any).TREB) {
  (self as any).TREB = {};
}

// (temporarily, atm) switching name to prevent overlap

(self as any).TREB.CreateChart2 = (node?: HTMLElement) => {
  const chart = new Chart();
  if (node) chart.Initialize(node);
  return chart;
};
