-- Add separate notes column for agent-editable content in source guides.
-- The content column stores the auto-generated header; notes stores free-form agent markdown.
ALTER TABLE knowledge_pages ADD COLUMN notes TEXT;
