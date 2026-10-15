import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Field, Input, Textarea } from './components/input.tsx';

describe('a field', () => {
  it('describes its control by the hint, or by the errors and marks it invalid', () => {
    const hinted = renderToStaticMarkup(
      <Field label="Name" htmlFor="f-name" hint="As in the passport">
        <Input id="f-name" name="name" />
      </Field>,
    );
    expect(hinted).toContain('aria-describedby="f-name-notes"');
    expect(hinted).toContain('id="f-name-notes"');
    expect(hinted).not.toContain('aria-invalid');

    const refused = renderToStaticMarkup(
      <Field label="About" htmlFor="f-about" error="Too long">
        <Textarea id="f-about" name="about" aria-describedby="counter" />
      </Field>,
    );
    expect(refused).toContain('aria-describedby="counter f-about-notes"');
    expect(refused).toContain('aria-invalid="true"');
  });

  it('leaves alone what is not the control its label names', () => {
    const html = renderToStaticMarkup(
      <Field label="Name" htmlFor="f-name" hint="Hint">
        <div>
          <Input id="f-name" name="name" />
        </div>
      </Field>,
    );
    expect(html).not.toContain('aria-describedby');
  });
});
