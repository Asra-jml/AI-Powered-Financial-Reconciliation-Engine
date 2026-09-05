/**
 * Whitelisted SQL query templates for the Q&A Agent
 */

export interface QueryTemplate {
  id: string;
  description: string;
  regex: RegExp;
  extractParams: (match: RegExpMatchArray) => Record<string, string>;
  sql: string;
  formatResult: (rows: any[], params: Record<string, string>) => string;
}

export const QA_TEMPLATES: QueryTemplate[] = [
  {
    id: 'missing_credits',
    description: 'Find settlements missing bank credits',
    regex: /(?:which\s+|show\s+me\s+|find\s+)?(?:\s*the\s+)?(?:settlements\s+)?(?:that\s+are\s+)?missing(?:\s+bank)?\s+credits/i,
    extractParams: () => ({}),
    sql: `
      SELECT settlement_id, expected_net_paise, settled_on 
      FROM settlements 
      WHERE run_id = @run_id AND status = 'missing'
      ORDER BY expected_net_paise DESC
      LIMIT 10
    `,
    formatResult: (rows) => {
      if (rows.length === 0) return 'No settlements are currently missing bank credits.';
      const lines = rows.map(r => `- ${r.settlement_id} (${r.settled_on}): ₹${(r.expected_net_paise / 100).toFixed(2)} expected`);
      return `Found ${rows.length} settlements missing bank credits:\n${lines.join('\n')}`;
    }
  },
  {
    id: 'fee_variances',
    description: 'Find fee variances',
    regex: /(?:show\s+|find\s+)?(?:\s*me\s+)?fee\s+variances(?:\s+above\s+(?:₹|rs\.?|rupees?)?\s*(\d+))?/i,
    extractParams: (match) => ({ minAmount: match[1] || '0' }),
    sql: `
      SELECT e.exception_id, e.amount_paise, json_extract(e.evidence, '$.payment_id') as payment_id
      FROM exceptions e
      WHERE e.run_id = @run_id AND e.class = 'FEE_VARIANCE' AND e.amount_paise >= @minAmount
      ORDER BY e.amount_paise DESC
      LIMIT 10
    `,
    formatResult: (rows, params) => {
      if (rows.length === 0) return `No fee variances found above ₹${params.minAmount}.`;
      const lines = rows.map(r => `- Payment ${r.payment_id}: Variance of ₹${(r.amount_paise / 100).toFixed(2)}`);
      return `Found ${rows.length} fee variances above ₹${params.minAmount}:\n${lines.join('\n')}`;
    }
  },
  {
    id: 'instrument_discrepancy',
    description: 'Total discrepancy for an instrument',
    regex: /total\s+discrepancy\s+for\s+([a-zA-Z]+)/i,
    extractParams: (match) => ({ instrument: match[1].toLowerCase() }),
    sql: `
      SELECT SUM(e.amount_paise) as total_discrepancy
      FROM exceptions e
      JOIN ledger_lines l ON l.line_id = json_extract(e.line_ids, '$[0]')
      WHERE e.run_id = @run_id AND l.instrument = @instrument COLLATE NOCASE
    `,
    formatResult: (rows, params) => {
      const total = rows[0]?.total_discrepancy || 0;
      return `The total discrepancy for instrument '${params.instrument}' is ₹${(total / 100).toFixed(2)}.`;
    }
  },
  {
    id: 'settlement_details',
    description: 'Why was a settlement light?',
    regex: /(?:why\s+(?:was|is)|explain)\s+(?:settlement\s+)?([a-zA-Z0-9_]+)\s+(?:light|short|tight|less)/i,
    extractParams: (match) => ({ settlement_id: match[1] }),
    sql: `
      SELECT e.class, e.amount_paise, e.explanation_text
      FROM exceptions e
      WHERE e.run_id = @run_id 
        AND (json_extract(e.evidence, '$.settlement_id') = @settlement_id OR e.explanation_text LIKE '%' || @settlement_id || '%')
    `,
    formatResult: (rows, params) => {
      if (rows.length === 0) return `Could not find exception details for settlement ${params.settlement_id}. It may have matched perfectly.`;
      const lines = rows.map(r => `- ${r.class}: ₹${(r.amount_paise / 100).toFixed(2)} (${r.explanation_text})`);
      return `Settlement ${params.settlement_id} had the following exceptions:\n${lines.join('\n')}`;
    }
  }
];
