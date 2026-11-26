/**
 * Lease PDF upload: kept in MEMORY only (never written to disk), at most 5 MB,
 * one file, and it must really be a PDF (the bytes start with "%PDF-"; the file
 * name and the browser's content type are not trusted).
 *
 * Multer's own errors (too large, unexpected field) become plain-English HttpErrors.
 */
import multer from 'multer';
import { badRequest, HttpError } from '../utils/httpError.js';

export const MAX_LEASE_BYTES = 5 * 1024 * 1024; // 5 MB
const PDF_MAGIC = Buffer.from('%PDF-');

const leaseUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LEASE_BYTES, files: 1, fields: 5 },
}).single('lease');

/** Parse the multipart upload into req.file (a Buffer in memory). */
export function receiveLeaseUpload(req, res, next) {
  leaseUpload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(
        new HttpError(413, 'FILE_TOO_LARGE', 'That file is over 5 MB. Upload a smaller PDF.'),
      );
    }
    if (err instanceof multer.MulterError) {
      return next(badRequest('Upload one PDF file using the form.'));
    }
    return next(err);
  });
}

/** True when the bytes start with the PDF signature "%PDF-". */
export function looksLikePdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

/** Require exactly one real PDF. Runs BEFORE the rate limit, so bad files don't count. */
export function requirePdf(req, res, next) {
  if (!req.file) return next(badRequest('Choose a PDF file to upload.'));
  if (!looksLikePdf(req.file.buffer)) {
    return next(badRequest("That file isn't a PDF. Upload your lease as a PDF."));
  }
  next();
}
