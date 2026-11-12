; Étapes ajoutées à l'installeur NSIS généré par Tauri.
;
; Association .pdf : « proposer, pas imposer ». La macro APP_ASSOCIATE de Tauri remplace la
; valeur par défaut de Software\Classes\.pdf (le lecteur choisi jusque-là) et garde l'ancienne
; dans « PDFReader.Document_backup ». Après l'installation, on remet le lecteur précédent et on
; déclare PDFReader comme une application capable d'ouvrir les PDF :
;   - « Ouvrir avec » (OpenWithProgids) ;
;   - Paramètres > Applications par défaut (Capabilities + RegisteredApplications).
; C'est l'utilisateur qui choisit, dans Windows ou depuis les Préférences de PDFReader.

!define PDFREADER_PROGID "PDFReader.Document"
!define PDFREADER_CAPS "Software\PDFReader\Capabilities"

!macro NSIS_HOOK_POSTINSTALL
  ; 1. Lecteur PDF précédent remis tel quel (rien si aucun n'était choisi).
  ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\.pdf" "${PDFREADER_PROGID}_backup"
  ${If} $R0 != ""
  ${AndIf} $R0 != "${PDFREADER_PROGID}"
    WriteRegStr SHELL_CONTEXT "Software\Classes\.pdf" "" "$R0"
  ${Else}
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf" ""
  ${EndIf}

  ; Migration depuis la version 0.1.0, dont l'installeur déclarait l'identifiant générique « PDF »
  ; et le posait comme lecteur par défaut. On ne retire cet identifiant que s'il lance PDFReader.
  ReadRegStr $R1 SHELL_CONTEXT "Software\Classes\PDF\shell\open\command" ""
  ${StrLoc} $R2 "$R1" "PDFReader.exe" ">"
  ${If} $R2 != ""
    DeleteRegKey SHELL_CONTEXT "Software\Classes\PDF"
    ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\.pdf" ""
    ${If} $R0 == "PDF"
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf" ""
    ${EndIf}
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf" "PDF_backup"
    ; La sauvegarde faite par APP_ASSOCIATE contient cet ancien identifiant : la désinstallation
    ; le remettrait comme lecteur par défaut.
    ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\.pdf" "${PDFREADER_PROGID}_backup"
    ${If} $R0 == "PDF"
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf" "${PDFREADER_PROGID}_backup"
    ${EndIf}
  ${EndIf}

  ; 2. Proposé dans « Ouvrir avec ».
  WriteRegStr SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "${PDFREADER_PROGID}" ""

  ; 3. Proposé dans les applications par défaut de Windows.
  WriteRegStr SHELL_CONTEXT "${PDFREADER_CAPS}" "ApplicationName" "PDFReader"
  WriteRegStr SHELL_CONTEXT "${PDFREADER_CAPS}" "ApplicationDescription" "Lire, annoter, remplir et signer des PDF."
  WriteRegStr SHELL_CONTEXT "${PDFREADER_CAPS}\FileAssociations" ".pdf" "${PDFREADER_PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "PDFReader" "${PDFREADER_CAPS}"

  ; Windows relit les associations.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "${PDFREADER_PROGID}"
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "PDFReader"
  DeleteRegKey SHELL_CONTEXT "Software\PDFReader"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; APP_UNASSOCIATE a remis la valeur sauvegardée ; une valeur vide ne doit pas rester.
  ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\.pdf" ""
  ${If} $R0 == ""
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf" ""
  ${EndIf}
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf" "${PDFREADER_PROGID}_backup"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
