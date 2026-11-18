-- Posteingang: Name, unter dem der Browser die Datei im Ablageordner (Unterordner Eingang/) gespeichert hat – weicht bei
-- gleichnamigen Dateien vom Dateinamen ab („Scan (2).pdf“). Damit lässt sich die Datei am Auftrag direkt öffnen.
alter table transport.eing_dokumente add column if not exists ablage_name text;
