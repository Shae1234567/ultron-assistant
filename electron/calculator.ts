/**
 * Safe arithmetic expression evaluator.
 *
 * Deliberately does NOT use eval() or new Function() - the input to this
 * module can originate from user or model-supplied text, and either of
 * those would be an arbitrary code execution risk. Instead this is a small
 * hand-written tokenizer + recursive-descent parser/evaluator that only
 * understands digits, `.`, and the operators `+ - * / ( ) ^ %`. Anything
 * else is rejected with a clear error rather than silently stripped.
 */

type TokenType = 'number' | '+' | '-' | '*' | '/' | '^' | '%' | '(' | ')';

interface Token {
  type: TokenType;
  value?: number;
}

function tokenize(expression: string): { tokens?: Token[]; error?: string } {
  const tokens: Token[] = [];
  let i = 0;
  const len = expression.length;

  while (i < len) {
    const ch = expression[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      let numStr = '';
      let sawDot = false;
      while (i < len && ((expression[i] >= '0' && expression[i] <= '9') || expression[i] === '.')) {
        if (expression[i] === '.') {
          if (sawDot) return { error: 'Invalid expression.' };
          sawDot = true;
        }
        numStr += expression[i];
        i++;
      }
      const num = Number(numStr);
      if (!Number.isFinite(num)) return { error: 'Invalid expression.' };
      tokens.push({ type: 'number', value: num });
      continue;
    }

    if (ch === '.') {
      // Leading dot, e.g. ".5" - handle same as number branch.
      let numStr = '.';
      i++;
      while (i < len && expression[i] >= '0' && expression[i] <= '9') {
        numStr += expression[i];
        i++;
      }
      if (numStr === '.') return { error: 'Invalid expression.' };
      const num = Number(numStr);
      if (!Number.isFinite(num)) return { error: 'Invalid expression.' };
      tokens.push({ type: 'number', value: num });
      continue;
    }

    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '^' || ch === '%' || ch === '(' || ch === ')') {
      tokens.push({ type: ch as TokenType });
      i++;
      continue;
    }

    return { error: 'Invalid expression.' };
  }

  return { tokens };
}

/**
 * Recursive-descent parser/evaluator over the token stream.
 * Grammar (standard precedence, ^ right-associative, unary +/- supported):
 *   expression := term (('+' | '-') term)*
 *   term       := factor (('*' | '/' | '%') factor)*
 *   factor     := power
 *   power      := unary ('^' power)?
 *   unary      := ('+' | '-') unary | primary
 *   primary    := number | '(' expression ')'
 */
class Parser {
  private tokens: Token[];
  private pos = 0;
  public error: string | null = null;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private fail(msg: string): number {
    if (!this.error) this.error = msg;
    return NaN;
  }

  parseExpression(): number {
    let value = this.parseTerm();
    if (this.error) return NaN;
    while (this.peek() && (this.peek()!.type === '+' || this.peek()!.type === '-')) {
      const op = this.advance()!.type;
      const rhs = this.parseTerm();
      if (this.error) return NaN;
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  private parseTerm(): number {
    let value = this.parsePower();
    if (this.error) return NaN;
    while (this.peek() && (this.peek()!.type === '*' || this.peek()!.type === '/' || this.peek()!.type === '%')) {
      const op = this.advance()!.type;
      const rhs = this.parsePower();
      if (this.error) return NaN;
      if (op === '*') {
        value = value * rhs;
      } else if (op === '/') {
        if (rhs === 0) return this.fail('Division by zero.');
        value = value / rhs;
      } else {
        if (rhs === 0) return this.fail('Division by zero.');
        value = value % rhs;
      }
    }
    return value;
  }

  private parsePower(): number {
    const base = this.parseUnary();
    if (this.error) return NaN;
    if (this.peek() && this.peek()!.type === '^') {
      this.advance();
      const exponent = this.parsePower(); // right-associative
      if (this.error) return NaN;
      return Math.pow(base, exponent);
    }
    return base;
  }

  private parseUnary(): number {
    const tok = this.peek();
    if (tok && (tok.type === '+' || tok.type === '-')) {
      this.advance();
      const value = this.parseUnary();
      if (this.error) return NaN;
      return tok.type === '-' ? -value : value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const tok = this.advance();
    if (!tok) return this.fail('Invalid expression.');

    if (tok.type === 'number') {
      return tok.value as number;
    }

    if (tok.type === '(') {
      const value = this.parseExpression();
      if (this.error) return NaN;
      const closing = this.advance();
      if (!closing || closing.type !== ')') return this.fail('Invalid expression.');
      return value;
    }

    return this.fail('Invalid expression.');
  }

  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }
}

/** Evaluates a plain arithmetic expression (+ - * / ( ) ^ % and decimals) without eval(). */
export function evaluate(expression: string): { ok: boolean; result?: number; error?: string } {
  if (typeof expression !== 'string' || expression.trim() === '') {
    return { ok: false, error: 'Invalid expression.' };
  }

  const { tokens, error: tokenError } = tokenize(expression);
  if (tokenError || !tokens || tokens.length === 0) {
    return { ok: false, error: 'Invalid expression.' };
  }

  const parser = new Parser(tokens);
  const result = parser.parseExpression();

  if (parser.error) {
    return { ok: false, error: parser.error };
  }
  if (!parser.atEnd()) {
    return { ok: false, error: 'Invalid expression.' };
  }
  if (!Number.isFinite(result)) {
    return { ok: false, error: 'Invalid expression.' };
  }

  return { ok: true, result };
}
