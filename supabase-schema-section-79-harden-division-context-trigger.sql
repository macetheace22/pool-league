-- Section 79: pin the division-context trigger search_path
--
-- This trigger function only inspects NEW.format and NEW.day. An empty
-- search_path is therefore safe and removes the mutable-search-path warning
-- without changing trigger behavior.

create or replace function public.set_division_iba_context()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.format is null or new.day is null then
    raise exception 'Division format and day are required; supply the IBA context explicitly.';
  end if;
  return new;
end;
$function$;
