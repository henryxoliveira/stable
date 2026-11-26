/**
 * Test fixtures for the AI lease summary. The fake client stands in for the
 * Anthropic SDK client, so NO test ever calls the real API.
 */

/** What a well-behaved model would send as the `record_lease_terms` tool input. */
export const GOOD_INPUT = Object.freeze({
  monthly_rent: '2400.00',
  security_deposit: '$2,400',
  lease_start: '2027-09-01',
  lease_end: '2028-08-31',
  utilities: { included: false, monthly_amount: '150', notes: 'Tenant pays PG&E.' },
  parking: { included: true, monthly_amount: null, notes: null },
  subletting: { allowed: 'with_permission', notes: 'Written consent required.' },
  // Wording from the fictional test lease (test-files/sample-lease-TEST.pdf): a descriptive
  // amount like this is NOT a plain figure, so it must be kept as text.
  penalties: [
    {
      description: 'Late fee if rent is received after the 3rd of the month',
      amount: '$150.00, plus $25.00 for each additional day late',
    },
    {
      description: 'Non-refundable cleaning fee, deducted from the security deposit',
      amount: '$500.00',
    },
  ],
  flagged_clauses: [
    {
      clause:
        'This lease renews automatically for 12 months unless the tenant gives 60 days notice.',
      reason: 'You could be locked in for another year if you forget to give notice.',
    },
  ],
});

/** A Messages API response whose content is one call to the lease tool. */
export function toolReply(input, extra = {}) {
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_fake', name: 'record_lease_terms', input }],
    ...extra,
  };
}

/**
 * A fake client with the same `messages.create(params)` shape as the SDK.
 * `reply` is a response object, an Error to throw, or a function of the params.
 * Every request is recorded in `calls` so tests can inspect what was sent.
 */
export function fakeClient(reply = toolReply(GOOD_INPUT)) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        if (reply instanceof Error) throw reply;
        return typeof reply === 'function' ? reply(params) : reply;
      },
    },
  };
}

/** Bytes that start with the PDF signature (enough for our checks; the fake never parses it). */
export const PDF_BYTES = Buffer.from('%PDF-1.7\n% sample lease for tests\n%%EOF\n');
