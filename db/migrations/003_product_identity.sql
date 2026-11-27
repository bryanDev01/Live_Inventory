-- Imported or manually created products must not be duplicated by a repeated import.
-- The canonical identity is the name plus the exact amounts and currencies.
create unique index if not exists product_identity_idx
  on product (lower(name), purchase_amount, purchase_currency, sale_amount, sale_currency);
