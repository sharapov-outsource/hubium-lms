import { describe, expect, it } from 'vitest';
import { LtiSettings } from './server.ts';

describe('LTI activity settings', () => {
  const toolId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

  it('take a pass grade up to the maximum, not above it', () => {
    expect(LtiSettings.safeParse({ toolId, gradeMax: 10, gradePass: 10 }).success).toBe(true);
    const above = LtiSettings.safeParse({ toolId, gradeMax: 10, gradePass: 12 });
    expect(above.success).toBe(false);
    expect(above.error?.issues[0]).toMatchObject({
      path: ['gradePass'],
      message: 'errors.common.passGradeAboveMax',
    });
  });
});
