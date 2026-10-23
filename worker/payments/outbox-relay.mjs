// MyMochis · Outbox relay (Cloudflare Worker)
// Spec: PROJECT.md §22.7, spec_id=25 (P0-1)
//
// La logica del relay vive en src/lib/payments/relay.js, compartida con el
// server Express. Este archivo es solo el punto de entrada del Worker: que
// existan dos copias del drain (una aqui y otra en el server) hacia que una se
// quede sin desplegar y el camino automatico vuelva a perder stock.
import { startOutboxRelay, stopOutboxRelay, runOnce } from '../../src/lib/payments/relay.js';

export { startOutboxRelay, stopOutboxRelay, runOnce };