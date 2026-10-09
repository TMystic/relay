-- Run as the database owner. No existing Relay/cloud tables are modified.
create schema if not exists relay_recovery;
revoke all on schema relay_recovery from public, anon, authenticated;
grant usage on schema relay_recovery to service_role;
create table if not exists relay_recovery.settings (
 id integer primary key check(id=1), setup_hash text not null check(setup_hash ~ '^[a-f0-9]{64}$')
);
create table if not exists relay_recovery.rooms (
 room text primary key check(room ~ '^[a-f0-9]{32}$'),
 auth_hash text not null check(auth_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 window_started timestamptz not null default now(), request_count integer not null default 0
);
create table if not exists relay_recovery.copies (
 room text not null references relay_recovery.rooms(room),
 device text not null check(device ~ '^[a-f0-9]{32}$'),
 version text not null check(version ~ '^[a-f0-9]{64}$'),
 cipher text not null check(octet_length(cipher) between 44 and 16777216),
 updated_at timestamptz not null default now(),
 primary key(room,device)
);
alter table relay_recovery.settings enable row level security;
alter table relay_recovery.rooms enable row level security;
alter table relay_recovery.copies enable row level security;
revoke all on all tables in schema relay_recovery from public,anon,authenticated;
grant select,insert,update on all tables in schema relay_recovery to service_role;

create or replace function public.relay_recovery_request(
 p_op text,p_room text,p_auth text,p_setup text default null,p_device text default null,
 p_previous text default null,p_version text default null,p_cipher text default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; existing text; old_size bigint; room_size bigint; total_size bigint;
begin
 if p_room !~ '^[a-f0-9]{32}$' or p_auth !~ '^[a-f0-9]{64}$' then raise exception 'Unauthorized'; end if;
 if p_op in ('put','provision') then
  perform 1 from relay_recovery.settings where id=1 for update;
 end if;
 if p_op='provision' then
  perform 1 from relay_recovery.settings where id=1 and setup_hash=p_setup for update;
  if not found then raise exception 'Unauthorized'; end if;
  if (select count(*) from relay_recovery.rooms)>=100 and not exists(select 1 from relay_recovery.rooms where room=p_room) then
   raise exception 'Capacity exceeded';
  end if;
  insert into relay_recovery.rooms(room,auth_hash) values(p_room,p_auth) on conflict do nothing;
 end if;
 perform 1 from relay_recovery.rooms where room=p_room and auth_hash=p_auth for update;
 if not found then raise exception 'Unauthorized'; end if;
 update relay_recovery.rooms set
  request_count=case when window_started<now()-interval '1 minute' then 1 else request_count+1 end,
  window_started=case when window_started<now()-interval '1 minute' then now() else window_started end
  where room=p_room;
 if (select request_count from relay_recovery.rooms where room=p_room)>1000 then raise exception 'Capacity exceeded'; end if;
 if p_op='provision' then return '{"ok":true}'::jsonb; end if;
 if p_op='list' then
  select jsonb_build_object('copies',coalesce(jsonb_agg(jsonb_build_object('device',device,'version',version)),'[]'::jsonb))
   into result from relay_recovery.copies where room=p_room;
  return result;
 end if;
 if p_op='get' then
  select jsonb_build_object('version',version,'cipher',cipher) into result
   from relay_recovery.copies where room=p_room and device=p_device;
  if result is null then raise exception 'Conflict'; end if;
  return result;
 end if;
 if p_op<>'put' or p_device is null or p_device !~ '^[a-f0-9]{32}$' or
   p_version is null or p_version !~ '^[a-f0-9]{64}$' or p_cipher is null then raise exception 'Invalid request'; end if;
 -- Serialize quota checks globally; never evict another device's only recovery copy.
 perform 1 from relay_recovery.settings where id=1 for update;
 select version,octet_length(cipher) into existing,old_size from relay_recovery.copies where room=p_room and device=p_device;
 if existing is distinct from p_previous then raise exception 'Conflict'; end if;
 if existing is null and (select count(*) from relay_recovery.copies where room=p_room)>=64 then raise exception 'Capacity exceeded'; end if;
 select coalesce(sum(octet_length(cipher)),0) into room_size from relay_recovery.copies where room=p_room;
 select coalesce(sum(octet_length(cipher)),0) into total_size from relay_recovery.copies;
 if room_size-coalesce(old_size,0)+octet_length(p_cipher)>134217728 or
   total_size-coalesce(old_size,0)+octet_length(p_cipher)>536870912 then raise exception 'Capacity exceeded'; end if;
 insert into relay_recovery.copies(room,device,version,cipher) values(p_room,p_device,p_version,p_cipher)
 on conflict(room,device) do update set version=excluded.version,cipher=excluded.cipher,updated_at=now();
 return '{"ok":true}'::jsonb;
end;
$$;
revoke all on function public.relay_recovery_request(text,text,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.relay_recovery_request(text,text,text,text,text,text,text,text) to service_role;
