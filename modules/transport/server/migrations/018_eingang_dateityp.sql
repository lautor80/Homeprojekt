-- Posteingang: Anhänge, die mit nichtssagendem Typ (application/octet-stream) geliefert wurden, aber PDFs sind,
-- als application/pdf kennzeichnen – sonst blieb die PDF-Vorschau leer (z. B. „…-POD-….PDF“). Neue Lieferungen bestimmen
-- den Typ aus dem Inhalt (server/src/lib/dateityp.ts); die Auslieferung prüft ihn zusätzlich.
update transport.eing_dokumente
   set mime = 'application/pdf'
 where coalesce(lower(mime), '') in ('', 'application/octet-stream', 'binary/octet-stream', 'application/x-download', 'application/force-download')
   and (inhalt like 'JVBERi0%' or lower(datei) like '%.pdf');
