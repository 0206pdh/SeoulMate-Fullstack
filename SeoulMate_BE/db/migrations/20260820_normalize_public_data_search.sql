alter table public_data
  add column if not exists district_name varchar(20),
  add column if not exists district_code varchar(5),
  add column if not exists region_search_text text,
  add column if not exists search_text text;

create or replace function normalize_public_data_search_columns()
returns trigger
language plpgsql
as $$
declare
  location_text text := coalesce(new.region, '') || ' ' || coalesce(new.address, '');
begin
  new.district_name := substring(
    location_text from
    '(종로구|중구|용산구|성동구|광진구|동대문구|중랑구|성북구|강북구|도봉구|노원구|은평구|서대문구|마포구|양천구|강서구|구로구|금천구|영등포구|동작구|관악구|서초구|강남구|송파구|강동구)'
  );

  new.district_code := case new.district_name
    when '종로구' then '11110' when '중구' then '11140'
    when '용산구' then '11170' when '성동구' then '11200'
    when '광진구' then '11215' when '동대문구' then '11230'
    when '중랑구' then '11260' when '성북구' then '11290'
    when '강북구' then '11305' when '도봉구' then '11320'
    when '노원구' then '11350' when '은평구' then '11380'
    when '서대문구' then '11410' when '마포구' then '11440'
    when '양천구' then '11470' when '강서구' then '11500'
    when '구로구' then '11530' when '금천구' then '11545'
    when '영등포구' then '11560' when '동작구' then '11590'
    when '관악구' then '11620' when '서초구' then '11650'
    when '강남구' then '11680' when '송파구' then '11710'
    when '강동구' then '11740' else null
  end;

  new.region_search_text := lower(
    concat_ws(' ', new.region, new.address, new.title)
  );
  new.search_text := lower(
    concat_ws(
      ' ',
      new.title,
      new.category,
      new.place_family,
      new.place_type,
      new.place_subtype,
      new.kakao_category_name,
      new.kakao_category_group_name,
      new.metadata ->> 'businessType',
      new.metadata ->> 'sanitizedBusinessType',
      new.metadata ->> 'theme',
      new.metadata ->> 'facilityType'
    )
  );
  return new;
end;
$$;

drop trigger if exists normalize_public_data_search_before_write on public_data;
create trigger normalize_public_data_search_before_write
before insert or update of region, address, title, category, place_family, place_type,
  place_subtype, kakao_category_name, kakao_category_group_name, metadata
on public_data
for each row
execute function normalize_public_data_search_columns();

update public_data
set region = region
where district_name is null
   or region_search_text is null
   or search_text is null;

create index if not exists idx_public_data_district_name
  on public_data(district_name);

create index if not exists idx_public_data_district_source_updated
  on public_data(district_name, source_dataset, updated_at desc, id desc);

create index if not exists idx_public_data_region_search_trgm
  on public_data using gin (region_search_text gin_trgm_ops);

create index if not exists idx_public_data_search_text_trgm
  on public_data using gin (search_text gin_trgm_ops);

analyze public_data;
