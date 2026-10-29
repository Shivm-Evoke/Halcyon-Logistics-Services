// Intake agent: completes incomplete delivery addresses before the order reaches the pick list.
// In the replay a seeded draw against addressFixRate stands in for "the address could be completed";
// in the live day Claude reads the order and drafts the client query when it could not.

/** @returns {{ agent:'intake', fixAddress:boolean, confidence:number, needsApproval:boolean, rule:string }} */
export function intakeDecide(order, settings, rand) {
  if (!order.address_incomplete) {
    return { agent: 'intake', fixAddress: false, confidence: 1, needsApproval: false, rule: 'Address complete' };
  }
  const fixAddress = rand() < settings.addressFixRate;
  return {
    agent: 'intake',
    fixAddress,
    confidence: fixAddress ? 0.9 : 0.5,
    needsApproval: fixAddress && order.account_tier === 'Tier 1',
    rule: fixAddress ? 'Address completed from the order details and client history' : 'Address not resolvable: client query sent',
  };
}
