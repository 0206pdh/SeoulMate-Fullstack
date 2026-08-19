create index if not exists idx_public_data_place_family_trgm
  on public_data using gin (place_family gin_trgm_ops);

create index if not exists idx_public_data_place_type_trgm
  on public_data using gin (place_type gin_trgm_ops);

create index if not exists idx_public_data_place_subtype_trgm
  on public_data using gin (place_subtype gin_trgm_ops);

create index if not exists idx_public_data_source_updated_id
  on public_data(source_dataset, updated_at desc, id desc);
