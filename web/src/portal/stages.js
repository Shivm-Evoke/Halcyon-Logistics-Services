// Shipment stages as customers and staff read them.
export const STAGES = ['received', 'picked', 'collected', 'in_transit', 'delivered'];
export const STAGE_LABEL = {
  received: 'Received', picked: 'Picked', collected: 'Collected by carrier', in_transit: 'In transit', delivered: 'Delivered',
  on_hold: 'On hold', cancelled: 'Cancelled',
};
export const stageTone = (s) => ({ delivered: 'good', on_hold: 'warn', cancelled: 'bad' }[s] || 'brand');
