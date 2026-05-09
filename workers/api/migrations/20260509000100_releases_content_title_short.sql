-- Adds content_title_short — verb-led headline with the product/version
-- subject removed, first letter capitalized. Used on surfaces where the
-- product and version are already shown elsewhere on the card (org-page
-- release feed, product-page feed). Generated alongside content_title and
-- content_summary in one Haiku 4.5 call.
ALTER TABLE releases ADD COLUMN content_title_short TEXT;
