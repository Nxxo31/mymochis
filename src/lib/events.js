// MyMochis · Bus de eventos en vivo (spec 57, r11).
//
// QUE RESUELVE
// El domicillero no debería tener que apretar "Refrescar" (o esperar los 20 s
// del poll) para saber que le asignaron un reparto. Con SSE (Server-Sent
// Events) nativo de Node —cero dependencias, cero sockets extra— el server
// empuja el evento y el portal repinta la cola.
//
// DISEÑO
//   - Un hub en memoria con los clientes conectados. El hub vive en el
//     proceso: si el server se reinicia, el EventSource del navegador se
//     reconecta solo (retry) y vuelve a pedir su cola.
//   - Cada evento se entrega SOLO a quien le interesa: el admin ve todo y el
//     domicillero ve únicamente los repartos que son suyos. Un domicillero
//     nunca recibe el evento de otro.
//   - El payload es mínimo (ids y estado). Los datos completos se piden por
//     la API: el evento es la señal de "hay novedad", no el dato.

let nextId = 1;
const clients = new Map();

export const EVENT_TYPES = ['dispatch.assigned', 'dispatch.status', 'dispatch.cod'];

/**
 * Conecta un cliente al bus. Devuelve la función para desconectarlo.
 *
 * @param {import('express').Response} res
 * @param {{role?: string, courierId?: number|null}} scope
 */
export function subscribe(res, { role = 'admin', courierId = null } = {}) {
  const id = nextId++;
  clients.set(id, { res, role, courierId });
  return () => {
    clients.delete(id);
  };
}

function wants(client, event) {
  if (client.role === 'admin') return true;
  if (client.courierId == null) return false;
  if (event.courier_id == null) return false;
  return Number(event.courier_id) === Number(client.courierId);
}

/**
 * Publica un evento a los clientes interested.
 *
 * @param {string} type   uno de EVENT_TYPES
 * @param {object} data   payload minimo (debe traer courier_id si es del
 *                        domicillero: es lo que decide quien lo recibe)
 */
export function publish(type, data = {}) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  let dropped = 0;
  for (const [id, client] of clients) {
    if (!wants(client, data)) continue;
    try {
      client.res.write(frame);
    } catch {
      clients.delete(id);
      dropped++;
    }
  }
  return { connected: clients.size, dropped };
}

export function stats() {
  return { connected: clients.size };
}
