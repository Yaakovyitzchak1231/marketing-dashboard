-- TAP-171: radius search ("leads within X miles of a place").
--
-- Free and keyless by design: no paid geocoder. A lead's position is the
-- centroid of its ZIP code (or, without a ZIP, of its city + state), read from
-- lp.postal_centroids -- a copy of the GeoNames postal-code dump (CC BY 4.0,
-- https://download.geonames.org/export/zip/), loaded by
-- the geo_load_centroids op (lib/geo/geonames.ts). Nothing here calls the network.
--
-- What this file adds:
--   lp.postal_centroids     ZIP -> lat/lng (+ place name, state) per country
--   lp.geocode_cache        typed-in places resolved once (lib/geo/geocode.ts)
--   lp.company_geo          one position per company (its own table -- see below)
--   lp.miles_between(...)   great-circle distance in statute miles
--   lp.company_geo_lookup() the ZIP-then-city lookup, used by the trigger and the backfill
--   a trigger that keeps centroid positions in step with postal_code/city/state/country
--
--   lp.company_geo_backfill() fills positions for existing companies in batches
--
-- A position is honest about where it came from: geo_source says
-- 'postal_centroid' (the ZIP's centre) or 'city_centroid' (the average of the
-- city's ZIP centres). No lp.company_geo row means "we don't know", never 0,0,
-- so a lead with no usable ZIP/city simply never matches a radius condition.

create table if not exists lp.postal_centroids (
  country      text not null,                  -- ISO 3166-1 alpha-2, upper case ('US')
  postal_code  text not null,                  -- as GeoNames writes it ('02134')
  place_name   text,
  admin1_code  text,                           -- state code in the US ('MA')
  admin1_name  text,                           -- 'Massachusetts'
  latitude     double precision not null check (latitude between -90 and 90),
  longitude    double precision not null check (longitude between -180 and 180),
  source       text not null default 'geonames',
  loaded_at    timestamptz not null default now(),
  primary key (country, postal_code)
);
create index if not exists postal_centroids_city_idx
  on lp.postal_centroids (country, upper(admin1_code), lower(place_name));
create index if not exists postal_centroids_city_name_idx
  on lp.postal_centroids (country, lower(admin1_name), lower(place_name));

create table if not exists lp.geocode_cache (
  query_norm   text primary key,               -- lower-cased, whitespace-collapsed input
  latitude     double precision check (latitude between -90 and 90),
  longitude    double precision check (longitude between -180 and 180),
  label        text,                           -- what the geocoder said the place is
  source       text not null,                  -- 'postal_centroid' | 'city_centroid' | 'nominatim'
  found        boolean not null default true,  -- false = the geocoder had no answer (cached so we don't re-ask)
  created_at   timestamptz not null default now()
);

-- A company's position lives in its own table, not as columns on lp.companies:
-- filling 34k positions must not bump companies.updated_at or mark every lead's
-- rule evaluation stale (the companies_updated / companies_eval_stale triggers fire
-- on any UPDATE of lp.companies).
create table if not exists lp.company_geo (
  company_id   bigint primary key references lp.companies(id) on delete cascade,
  latitude     double precision not null check (latitude between -90 and 90),
  longitude    double precision not null check (longitude between -180 and 180),
  geo_source   text not null,                  -- 'postal_centroid' | 'city_centroid' (or a future precise source)
  geocoded_at  timestamptz not null default now()
);
create index if not exists company_geo_latlng_idx on lp.company_geo (latitude, longitude);

-- Great-circle (haversine) distance in statute miles; Earth radius 3958.7613 mi.
create or replace function lp.miles_between(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision
language sql immutable strict parallel safe as $$
  select 2 * 3958.7613 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  )))
$$;

-- Is this a US company? A blank country counts as US (the lead lists are US).
create or replace function lp.is_us_country(country text)
returns boolean language sql immutable parallel safe as $$
  select coalesce(upper(trim(country)), '') in ('', 'US', 'USA', 'U.S.', 'U.S.A.', 'UNITED STATES', 'UNITED STATES OF AMERICA')
$$;

-- The one lookup: ZIP centroid first, else city+state centroid. Returns no row
-- when neither is known. US only for now (that is what GeoNames' US file holds;
-- other countries' files load the same way and need only this function widened).
create or replace function lp.company_geo_lookup(p_postal text, p_city text, p_state text, p_country text)
returns table (latitude double precision, longitude double precision, geo_source text)
language plpgsql stable as $$
declare
  digits text;
  zip5   text;
begin
  if not lp.is_us_country(p_country) then return; end if;
  digits := regexp_replace(coalesce(p_postal, ''), '[^0-9]', '', 'g');
  if length(digits) between 3 and 5 or length(digits) = 9 then
    -- spreadsheets drop leading zeros ("2134" for 02134): pad a short ZIP back out.
    zip5 := case when length(digits) = 9 then left(digits, 5) else lpad(digits, 5, '0') end;
    return query
      select pc.latitude, pc.longitude, 'postal_centroid'::text
      from lp.postal_centroids pc where pc.country = 'US' and pc.postal_code = zip5;
    if found then return; end if;
  end if;
  if nullif(trim(coalesce(p_city, '')), '') is not null and nullif(trim(coalesce(p_state, '')), '') is not null then
    return query
      select avg(pc.latitude), avg(pc.longitude), 'city_centroid'::text
      from lp.postal_centroids pc
      where pc.country = 'US'
        and lower(pc.place_name) = lower(trim(p_city))
        and (upper(pc.admin1_code) = upper(trim(p_state)) or lower(pc.admin1_name) = lower(trim(p_state)))
      having count(*) > 0;
  end if;
end $$;

-- Keep centroid-derived positions in step with the address. A position from any
-- other source (a future precise geocoder, a hand edit) is left alone.
create or replace function lp.companies_geo_fill()
returns trigger language plpgsql as $$
declare
  g   record;
  cur text;
begin
  if tg_op = 'UPDATE'
     and new.postal_code is not distinct from old.postal_code
     and new.city is not distinct from old.city
     and new.state is not distinct from old.state
     and new.country is not distinct from old.country then
    return null;
  end if;
  select geo_source into cur from lp.company_geo where company_id = new.id;
  if cur is not null and cur not in ('postal_centroid', 'city_centroid') then
    return null;
  end if;
  select * into g from lp.company_geo_lookup(new.postal_code, new.city, new.state, new.country) limit 1;
  if g.latitude is null then
    delete from lp.company_geo where company_id = new.id;
  else
    insert into lp.company_geo (company_id, latitude, longitude, geo_source, geocoded_at)
    values (new.id, g.latitude, g.longitude, g.geo_source, now())
    on conflict (company_id) do update set latitude = excluded.latitude, longitude = excluded.longitude,
      geo_source = excluded.geo_source, geocoded_at = excluded.geocoded_at;
  end if;
  return null;
end $$;

drop trigger if exists companies_geo_fill on lp.companies;
create trigger companies_geo_fill
  after insert or update of postal_code, city, state, country on lp.companies
  for each row execute function lp.companies_geo_fill();

-- Fill every company that has no position yet from the centroid table, in id order,
-- `batch` at a time; returns how many positions were written and the last id read
-- (pass it back as after_id). Writes only lp.company_geo, never lp.companies.
create or replace function lp.company_geo_backfill(after_id bigint, batch int)
returns table (filled int, scanned int, last_id bigint)
language sql as $$
  with b as (
    select c.id, c.postal_code, c.city, c.state, c.country
      from lp.companies c
     where c.id > coalesce(after_id, 0)
     order by c.id
     limit greatest(1, least(coalesce(batch, 1000), 5000))
  ),
  ins as (
    insert into lp.company_geo (company_id, latitude, longitude, geo_source)
    select b.id, g.latitude, g.longitude, g.geo_source
      from b
      cross join lateral lp.company_geo_lookup(b.postal_code, b.city, b.state, b.country) g
     where g.latitude is not null
    on conflict (company_id) do nothing
    returning 1
  )
  select (select count(*) from ins)::int, (select count(*) from b)::int, (select max(id) from b)
$$;
