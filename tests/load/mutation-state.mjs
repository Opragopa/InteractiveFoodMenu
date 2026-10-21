// Only these scalar menu fields may enter evidence; never serialize request
// headers, account data, display credentials or arbitrary response objects.
export function itemState(item) {
  if (!item || typeof item.id !== 'string' || typeof item.isAvailable !== 'boolean' || !Number.isInteger(item.priceMinor)) throw new Error('Invalid menu item evidence.');
  const stockQuantity = item.stockQuantity == null ? null : item.stockQuantity;
  if (stockQuantity !== null && (!Number.isInteger(stockQuantity) || stockQuantity < 0)) throw new Error('Invalid stock evidence.');
  return { stockQuantity, isAvailable: stockQuantity === null ? item.isAvailable : stockQuantity > 0, priceMinor: item.priceMinor };
}
export function mutationEvidence(route, actor, data, body) {
  if (route === 'break-write') {
    if (data?.venue?.id !== actor.venueId || typeof data.venue.breakActive !== 'boolean') throw new Error('Invalid break evidence.');
    return { version: 1, venueId: actor.venueId, operation: route, state: { breakActive: data.venue.breakActive } };
  }
  const itemId = route === 'stock-adjust' ? actor.itemId : actor.untrackedItemId;
  if (data?.item?.id !== itemId || data.item.venueId && data.item.venueId !== actor.venueId) throw new Error('Mutation item identity differs.');
  const result = { version: 1, venueId: actor.venueId, itemId, operation: route, state: itemState(data.item) };
  if (route === 'stock-adjust') {
    if (![1, -1].includes(body?.delta)) throw new Error('Invalid stock delta evidence.');
    result.delta = body.delta;
  }
  return result;
}
