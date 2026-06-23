# 🌐 Настройка Supabase для онлайна

## Шаг 1: Создание таблиц

1. Открой свой проект на https://app.supabase.com
2. Левое меню → **SQL Editor**
3. Нажми **+ New query**
4. Скопируй и вставь весь SQL ниже
5. Нажми **Run** (или Ctrl+Enter)

```sql
-- ============================================================
-- Дом Палача — Онлайн-мультиплеер (схема БД)
-- ============================================================

-- Удалим старые таблицы если были (для чистой переустановки)
DROP TABLE IF EXISTS game_state CASCADE;
DROP TABLE IF EXISTS lobby_players CASCADE;
DROP TABLE IF EXISTS lobbies CASCADE;

-- === Таблица лобби ===
CREATE TABLE lobbies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  host_id TEXT NOT NULL,
  host_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting', -- waiting | playing | finished
  max_players INT NOT NULL DEFAULT 4,
  is_public BOOLEAN DEFAULT true,
  settings JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_lobbies_code ON lobbies(code);
CREATE INDEX idx_lobbies_status ON lobbies(status, is_public);

-- === Таблица игроков в лобби ===
CREATE TABLE lobby_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_id UUID NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,  -- генерируется клиентом (UUID)
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'victim', -- host | maniac | victim
  ready BOOLEAN DEFAULT false,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(lobby_id, player_id)
);
CREATE INDEX idx_lobby_players_lobby ON lobby_players(lobby_id);

-- === Таблица игрового состояния (realtime синхронизация) ===
CREATE TABLE game_state (
  lobby_id UUID PRIMARY KEY REFERENCES lobbies(id) ON DELETE CASCADE,
  state JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- Anon-ключ публичный, защищаем через политики
-- ============================================================

ALTER TABLE lobbies ENABLE ROW LEVEL SECURITY;
ALTER TABLE lobby_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_state ENABLE ROW LEVEL SECURITY;

-- Все могут видеть лобби, создавать новые, обновлять (для простоты MVP)
CREATE POLICY "anyone can read lobbies" ON lobbies FOR SELECT USING (true);
CREATE POLICY "anyone can create lobby" ON lobbies FOR INSERT WITH CHECK (true);
CREATE POLICY "anyone can update lobby" ON lobbies FOR UPDATE USING (true);
CREATE POLICY "anyone can delete lobby" ON lobbies FOR DELETE USING (true);

CREATE POLICY "anyone can read players" ON lobby_players FOR SELECT USING (true);
CREATE POLICY "anyone can join" ON lobby_players FOR INSERT WITH CHECK (true);
CREATE POLICY "anyone can update self" ON lobby_players FOR UPDATE USING (true);
CREATE POLICY "anyone can leave" ON lobby_players FOR DELETE USING (true);

CREATE POLICY "anyone can read state" ON game_state FOR SELECT USING (true);
CREATE POLICY "anyone can write state" ON game_state FOR INSERT WITH CHECK (true);
CREATE POLICY "anyone can update state" ON game_state FOR UPDATE USING (true);

-- ============================================================
-- REALTIME (включение для нужных таблиц)
-- ============================================================
-- Уже включён по умолчанию в Supabase, но на всякий случай:
ALTER PUBLICATION supabase_realtime ADD TABLE lobbies;
ALTER PUBLICATION supabase_realtime ADD TABLE lobby_players;
ALTER PUBLICATION supabase_realtime ADD TABLE game_state;

-- ============================================================
-- Автоочистка старых лобби (через cron-функцию или вручную)
-- Можно запускать раз в час чтобы удалять брошенные лобби >1 часа
-- ============================================================
CREATE OR REPLACE FUNCTION cleanup_old_lobbies() RETURNS void AS $$
BEGIN
  DELETE FROM lobbies WHERE updated_at < NOW() - INTERVAL '1 hour';
END;
$$ LANGUAGE plpgsql;

-- Готово! Проверка:
SELECT
  (SELECT COUNT(*) FROM lobbies) AS lobbies_count,
  (SELECT COUNT(*) FROM lobby_players) AS players_count;
```

## Шаг 2: Проверка

После запуска SQL ты должен увидеть в нижней панели:
```
| lobbies_count | players_count |
|       0       |       0       |
```

Если так — всё ок! ✅

Если ошибка — пришли её текст, разберёмся.

## Шаг 3: Включить Realtime (если не включился автоматически)

1. Левое меню → **Database** → **Replication**
2. Найди таблицы `lobbies`, `lobby_players`, `game_state`
3. Включи **Source** = `supabase_realtime` для всех трёх

## Шаг 4: Проверь что Anon ключ читает данные

В **SQL Editor** запусти:
```sql
SELECT * FROM lobbies LIMIT 5;
```
Должен вернуть пустую таблицу (без ошибки).
