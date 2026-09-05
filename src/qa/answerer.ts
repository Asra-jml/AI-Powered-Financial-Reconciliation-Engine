/**
 * Q&A Agent Answerer
 * Matches natural language queries to SQL templates and executes them.
 */

import { QA_TEMPLATES } from './templates';
import { getDb } from '../db/database';

export interface QAResult {
  answer: string;
  template_id?: string;
  params?: Record<string, string>;
  rows?: any[];
  error?: string;
}

export function answerQuery(runId: string, query: string): QAResult {
  const db = getDb();

  for (const template of QA_TEMPLATES) {
    const match = query.match(template.regex);
    if (match) {
      const params = template.extractParams(match);
      
      try {
        // Convert paise param if necessary
        const sqlParams: Record<string, any> = { run_id: runId };
        for (const [k, v] of Object.entries(params)) {
          sqlParams[k] = k === 'minAmount' ? Math.round(parseFloat(v) * 100) : v;
        }

        const rows = db.prepare(template.sql).all(sqlParams);
        const answer = template.formatResult(rows, params);

        return {
          answer,
          template_id: template.id,
          params,
          rows
        };
      } catch (err: any) {
        return {
          answer: `Error executing query: ${err.message}`,
          error: err.message
        };
      }
    }
  }

  return {
    answer: "I don't understand that query. Try asking about 'missing credits', 'fee variances above ₹X', 'total discrepancy for card', or 'why was settlement_id light'."
  };
}
