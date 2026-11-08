-- DEC-129: docs/06_schema.sql v1.1 declared whatsapp_templates.name CHECK (name ~ '^[a-z0-9_]{1,512}$'), which
-- PostgreSQL rejects when it evaluates the check (regex repetition bound > 255 → 2201B), so no template row could
-- ever be inserted. Same constraint name, equivalent rule; 06_schema.sql carries the corrected check.
ALTER TABLE whatsapp_templates DROP CONSTRAINT whatsapp_templates_name_check;
ALTER TABLE whatsapp_templates ADD CONSTRAINT whatsapp_templates_name_check
  CHECK (name ~ '^[a-z0-9_]+$' AND char_length(name) <= 512);
