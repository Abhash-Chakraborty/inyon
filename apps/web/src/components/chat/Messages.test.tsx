import { expect, test } from 'bun:test'
import { uploadName } from './Messages.tsx'

test("an upload's chip shows the name it was picked with", () => {
  expect(uploadName('/home/me/.inyon/uploads/2026-10-13/d09c14d4-62c/184807-76855d-inyon-test.txt')).toBe('inyon-test.txt')
  // uploads from before the id was added
  expect(uploadName('/home/me/.inyon/uploads/2026-01-02/x/101010-photo.jpg')).toBe('photo.jpg')
  // a name that only looks like the prefix keeps the rest
  expect(uploadName('/home/me/.inyon/uploads/2026-10-13/x/184807-76855d-123456-notes.md')).toBe('123456-notes.md')
})
