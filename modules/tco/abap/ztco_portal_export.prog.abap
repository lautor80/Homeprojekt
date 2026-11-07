*&---------------------------------------------------------------------*
*& Report ZTCO_PORTAL_EXPORT
*&---------------------------------------------------------------------*
*& Export ALLER TCO-Tabellen für die Übernahme ins neue Vereinsportal.
*& Ergebnis: eine ZIP-Datei mit je Tabelle einer CSV-Datei
*&   - Dateiname = Tabellenname (ZTCO_MITGLIEDER.CSV …)
*&   - Kopfzeile = SAP-Feldnamen (ohne Mandant), Trennzeichen ";", UTF-8
*&   - Werte im internen Format: Datum JJJJMMTT, Uhrzeit HHMMSS,
*&     Beträge mit Punkt; Felder mit ; " oder Zeilenumbruch in "…"
*& Die ZIP-Datei im Portal unter TC Oberthal → Stammdaten →
*& Übernahme aus SAP hochladen (Prüfen, dann Übernehmen).
*& Der Report liest nur, er ändert keine Daten.
*&---------------------------------------------------------------------*
REPORT ztco_portal_export.

PARAMETERS p_file TYPE string LOWER CASE.

CLASS lcl_export DEFINITION FINAL.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_prot,
             tabelle TYPE tabname,
             saetze  TYPE i,
             hinweis TYPE string,
           END OF ty_prot,
           ty_t_prot TYPE STANDARD TABLE OF ty_prot WITH EMPTY KEY.

    CLASS-METHODS tabellen
      RETURNING VALUE(rt_tab) TYPE string_table.
    CLASS-METHODS zip_erzeugen
      EXPORTING et_prot       TYPE ty_t_prot
      RETURNING VALUE(rv_zip) TYPE xstring.
    CLASS-METHODS csv
      IMPORTING iv_tab        TYPE tabname
      EXPORTING ev_saetze     TYPE i
                ev_fehlt      TYPE abap_bool
      RETURNING VALUE(rv_csv) TYPE string.
    CLASS-METHODS wert
      IMPORTING iv_inttype  TYPE inttype
                ia_wert     TYPE any
      RETURNING VALUE(rv)   TYPE string.
    CLASS-METHODS feld
      IMPORTING iv          TYPE string
      RETURNING VALUE(rv)   TYPE string.
ENDCLASS.

CLASS lcl_export IMPLEMENTATION.

  METHOD tabellen.
    " Reihenfolge wie im Portal (z. B. Rechnungskopf vor Positionen)
    rt_tab = VALUE #(
      ( `ZTCO_MITGLIEDER` ) ( `ZTCO_MITGLIEDERA` ) ( `ZTCO_SEPA` ) ( `ZTCO_VERTRAEGE` ) ( `ZTCO_BEITRAG` ) ( `ZTCO_BEITRAG_PR` )
      ( `ZTCO_MGNOTIZ` ) ( `ZTCO_KOMMPREF` ) ( `ZTCO_SCHLUESSEL` ) ( `ZTCO_ANTRAG_MAP` )
      ( `ZTCO_KUNDEN` ) ( `ZTCO_BOOKINGS` ) ( `ZTCO_BOOKINGS_CH` ) ( `ZTCO_BOOKINGSTXT` ) ( `ZTCO_PRODUKTE` ) ( `ZTCO_PRMATRIX` )
      ( `ZTCO_RGKOPF` ) ( `ZTCO_RGPOS` ) ( `ZTCO_RGTZ` )
      ( `ZTCO_FIKONTEN` ) ( `ZTCO_FIKONTOJAHR` ) ( `ZTCO_FIBUCHUNGEN` ) ( `ZTCO_FIBANKAB` ) ( `ZTCO_FINOTIZ` ) ( `ZTCO_FIPAPERMAP` )
      ( `ZTCO_PAPERLESS` ) ( `ZTCO_PROJEKTE` ) ( `ZTCO_ANLAGEN` )
      ( `ZTCO_SOLL_CFG` ) ( `ZTCO_SOLL_KOPF` ) ( `ZTCO_SOLL_POS` )
      ( `ZTCO_FORD` ) ( `ZTCO_FORDERUNGEN` ) ( `ZTCO_WERG` ) ( `ZTCO_WERG_BELEG` ) ( `ZTCO_WERG_PL` )
      ( `ZTCO_JRUECKM` ) ( `ZTCO_JT_DOKU` ) ( `ZTCO_TRENTGELT` ) ( `ZTCO_TPLAN` ) ( `ZTCO_TFREI` ) ( `ZTCO_FERIEN` )
      ( `ZTCO_RPT_VARIANT` ) ).
  ENDMETHOD.

  METHOD zip_erzeugen.
    DATA lv_saetze TYPE i.
    DATA lv_fehlt  TYPE abap_bool.
    DATA(lo_zip) = NEW cl_abap_zip( ).
    CLEAR et_prot.
    LOOP AT tabellen( ) INTO DATA(lv_name).
      DATA(lv_tab) = CONV tabname( lv_name ).
      DATA(ls_prot) = VALUE ty_prot( tabelle = lv_tab ).
      TRY.
          DATA(lv_csv) = csv( EXPORTING iv_tab = lv_tab IMPORTING ev_saetze = lv_saetze ev_fehlt = lv_fehlt ).
          ls_prot-saetze = lv_saetze.
          IF lv_fehlt = abap_true.
            ls_prot-hinweis = `Tabelle nicht vorhanden – übersprungen`.
            APPEND ls_prot TO et_prot.
            CONTINUE.
          ENDIF.
          lo_zip->add( name    = |{ lv_tab }.CSV|
                       content = cl_abap_codepage=>convert_to( source = lv_csv codepage = `UTF-8` ) ).
        CATCH cx_root INTO DATA(lx).
          ls_prot-hinweis = lx->get_text( ).
      ENDTRY.
      APPEND ls_prot TO et_prot.
    ENDLOOP.
    rv_zip = lo_zip->save( ).
  ENDMETHOD.

  METHOD csv.
    DATA lr_data   TYPE REF TO data.
    DATA lt_zeilen TYPE string_table.
    DATA lt_felder TYPE string_table.
    FIELD-SYMBOLS <lt_data> TYPE STANDARD TABLE.

    cl_abap_typedescr=>describe_by_name( EXPORTING  p_name         = iv_tab
                                         RECEIVING  p_descr_ref    = DATA(lo_type)
                                         EXCEPTIONS type_not_found = 1
                                                    OTHERS         = 2 ).
    CLEAR: ev_saetze, ev_fehlt.
    IF sy-subrc <> 0 OR lo_type->kind <> cl_abap_typedescr=>kind_struct.
      ev_fehlt = abap_true.
      RETURN.
    ENDIF.
    DATA(lt_comp) = CAST cl_abap_structdescr( lo_type )->get_ddic_field_list( ).
    DELETE lt_comp WHERE fieldname = 'MANDT' OR fieldname = 'CLIENT'.

    CREATE DATA lr_data TYPE STANDARD TABLE OF (iv_tab).
    ASSIGN lr_data->* TO <lt_data>.
    SELECT * FROM (iv_tab) INTO TABLE @<lt_data>.
    ev_saetze = lines( <lt_data> ).

    LOOP AT lt_comp INTO DATA(ls_c).
      APPEND CONV string( ls_c-fieldname ) TO lt_felder.
    ENDLOOP.
    APPEND concat_lines_of( table = lt_felder sep = `;` ) TO lt_zeilen.

    LOOP AT <lt_data> ASSIGNING FIELD-SYMBOL(<ls_row>).
      CLEAR lt_felder.
      LOOP AT lt_comp INTO ls_c.
        ASSIGN COMPONENT ls_c-fieldname OF STRUCTURE <ls_row> TO FIELD-SYMBOL(<lv>).
        IF sy-subrc <> 0.
          APPEND `` TO lt_felder.
        ELSE.
          APPEND feld( wert( iv_inttype = ls_c-inttype ia_wert = <lv> ) ) TO lt_felder.
        ENDIF.
      ENDLOOP.
      APPEND concat_lines_of( table = lt_felder sep = `;` ) TO lt_zeilen.
    ENDLOOP.
    rv_csv = concat_lines_of( table = lt_zeilen sep = cl_abap_char_utilities=>cr_lf ).
  ENDMETHOD.

  METHOD wert.
    CASE iv_inttype.
      WHEN 'D'.                                   " Datum JJJJMMTT, leer statt 00000000
        rv = COND #( WHEN ia_wert IS INITIAL THEN `` ELSE |{ ia_wert }| ).
      WHEN 'T'.                                   " Uhrzeit HHMMSS
        rv = |{ ia_wert }|.
      WHEN 'P' OR 'F' OR 'I' OR 'b' OR 's' OR '8' OR 'a' OR 'e'.   " Zahlen mit Punkt
        rv = |{ ia_wert NUMBER = RAW }|.
      WHEN 'X' OR 'y'.                            " Rohdaten hexadezimal
        rv = |{ ia_wert }|.
      WHEN OTHERS.                                " C, N, STRING
        rv = ia_wert.
    ENDCASE.
  ENDMETHOD.

  METHOD feld.
    rv = iv.
    IF rv CA |;"{ cl_abap_char_utilities=>cr_lf }|.
      REPLACE ALL OCCURRENCES OF `"` IN rv WITH `""`.
      rv = |"{ rv }"|.
    ENDIF.
  ENDMETHOD.

ENDCLASS.


INITIALIZATION.
  p_file = |TCO_PORTAL_EXPORT_{ sy-datum }.zip|.

AT SELECTION-SCREEN ON VALUE-REQUEST FOR p_file.
  DATA lv_name TYPE string.
  DATA lv_path TYPE string.
  DATA lv_full TYPE string.
  cl_gui_frontend_services=>file_save_dialog(
    EXPORTING  default_extension = `zip`
               default_file_name = p_file
               file_filter       = `ZIP (*.zip)|*.zip`
    CHANGING   filename          = lv_name
               path              = lv_path
               fullpath          = lv_full
    EXCEPTIONS OTHERS            = 1 ).
  IF sy-subrc = 0 AND lv_full IS NOT INITIAL.
    p_file = lv_full.
  ENDIF.

START-OF-SELECTION.
  DATA lt_prot TYPE lcl_export=>ty_t_prot.
  DATA(lv_zip) = lcl_export=>zip_erzeugen( IMPORTING et_prot = lt_prot ).
  DATA(lt_bin) = cl_bcs_convert=>xstring_to_solix( lv_zip ).

  cl_gui_frontend_services=>gui_download(
    EXPORTING  bin_filesize = xstrlen( lv_zip )
               filename     = p_file
               filetype     = 'BIN'
    CHANGING   data_tab     = lt_bin
    EXCEPTIONS OTHERS       = 1 ).
  IF sy-subrc <> 0.
    WRITE: / 'Download fehlgeschlagen:', p_file COLOR COL_NEGATIVE.
  ELSE.
    WRITE: / 'Exportiert nach', p_file COLOR COL_POSITIVE.
  ENDIF.
  SKIP.
  LOOP AT lt_prot INTO DATA(ls_p).
    IF ls_p-hinweis IS INITIAL.
      WRITE: / ls_p-tabelle, ls_p-saetze.
    ELSE.
      WRITE: / ls_p-tabelle, ls_p-saetze, ls_p-hinweis COLOR COL_TOTAL.
    ENDIF.
  ENDLOOP.
