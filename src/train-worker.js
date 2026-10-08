// Runs model training off the main thread so the server stays responsive.
import { parentPort, workerData } from 'node:worker_threads';
import { trainLocation } from './model/forecaster.js';

try {
  parentPort.postMessage({ ok: true, model: trainLocation(workerData.series, workerData.options) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
