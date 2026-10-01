import { describe, expect, it } from 'vitest';
import { schoolUrl } from './schoolUrl';

describe('the D2L address, however it is typed', () => {
  it('accepts a bare address, http, or a whole copied link', () => {
    expect(schoolUrl('myschool.brightspace.com')).toBe('https://myschool.brightspace.com');
    expect(schoolUrl('  http://MySchool.Brightspace.com/ ')).toBe('https://myschool.brightspace.com');
    expect(schoolUrl('https://d2l.myboard.ca/d2l/home/12345')).toBe('https://d2l.myboard.ca');
  });

  it('turns anything that is not a web address into "not set up"', () => {
    expect(schoolUrl('')).toBe('');
    expect(schoolUrl('my school')).toBe('');
    expect(schoolUrl('brightspace')).toBe('');
    expect(schoolUrl('ftp://files.school.com')).toBe('');
  });
});

