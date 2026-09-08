CREATE UNIQUE INDEX IF NOT EXISTS one_open_protection_event_per_position_type
  ON protection_events(position_id, event_type)
  WHERE status = 'action_required';
