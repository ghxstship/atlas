-- 0933_scan_symbology_gtin.sql
-- Orchestrator correction to A03F's 0367. Section 13 lists ITF-14, and EAN-8 is a GTIN format, so
-- Compass must be able to send both to the scan intake queue. Enum values are added in their own
-- migration so no later statement uses them in the same transaction.

alter type app.scan_symbology add value if not exists 'EAN-8' after 'EAN-13';
alter type app.scan_symbology add value if not exists 'ITF-14' after 'UPC-A';
