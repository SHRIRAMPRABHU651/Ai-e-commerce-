# Image pipeline

Real product photos come from the supplier API (or an admin upload). Orvia does not generate or substitute images.

1. **Ingest** (`image_ingestion` job): fetched through the SSRF-safe `guardedFetch` (public hosts only, size/type limits, redirects re-checked).
2. **Process** (sharp): validated as an image, min dimension `MEDIA_MIN_DIMENSION`, EXIF stripped, WebP variants, sha256 + dHash dedupe.
3. **Store**: `ObjectStorage` — `local` (dev, served at `/api/v1/media/*`) or `s3` (any S3-compatible) behind `CDN_BASE_URL`.
4. **Serve**: production serves only Orvia-hosted URLs; supplier URLs are never hotlinked. Missing images block publishing (`IMAGE_REQUIRED`) and raise `MISSING_IMAGE` exceptions.
5. **Admin**: product → Images tab for upload, reorder, primary, delete; product list filter "images need attention".

Production requires `OBJECT_STORAGE_PROVIDER=s3`, a bucket, and an https `CDN_BASE_URL` (enforced at startup). S3Storage has not been run against a real bucket from this repo — `verify:staging` exercises a write/read/delete round trip.
