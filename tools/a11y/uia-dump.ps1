# Lit l'arbre d'accessibilité Windows (UI Automation) de la fenêtre de PDFReader, comme le
# ferait un lecteur d'écran, et vérifie quelques règles : tout bouton a un nom, le document est
# annoncé avec sa page, le texte de la page est exposé, les onglets et barres d'outils sont nommés.
# Outil de développement.
#   powershell -File tools/a11y/uia-dump.ps1 -ProcessId 1234 [-Out arbre.txt]
param([Parameter(Mandatory = $true)][int]$ProcessId, [string]$Out = "", [int]$MaxNodes = 4000)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$cond = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $ProcessId)
$win = $A::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { Write-Error "fenêtre introuvable"; exit 1 }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$lines = New-Object System.Collections.Generic.List[string]
$stats = @{ buttons = 0; unnamedButtons = @(); document = ""; textChars = 0; tabs = @(); toolbars = @(); links = 0; edits = 0 }
$count = 0
function Walk($el, $depth) {
  if ($script:count -ge $MaxNodes) { return }
  $script:count++
  $type = $el.Current.ControlType.ProgrammaticName -replace "ControlType\.", ""
  $name = $el.Current.Name
  $lines.Add(("  " * $depth) + "$type : $name")
  switch ($type) {
    "Button" { $stats.buttons++; if ([string]::IsNullOrWhiteSpace($name)) { $stats.unnamedButtons += ("  " * $depth) + "(parent : " + $walker.GetParent($el).Current.Name + ")" } }
    "Document" { if ($name -match "page \d+ sur \d+|page \d+ of \d+") { $stats.document = $name } }
    "Text" { $stats.textChars += $name.Length }
    "TabItem" { $stats.tabs += $name }
    "ToolBar" { $stats.toolbars += $name }
    "Hyperlink" { $stats.links++ }
    "Edit" { $stats.edits++ }
  }
  $child = $walker.GetFirstChild($el)
  while ($child) { Walk $child ($depth + 1); $child = $walker.GetNextSibling($child) }
}
Walk $win 0
if ($Out) { $lines | Set-Content -Encoding utf8 $Out }
"éléments lus : $count"
"boutons : $($stats.buttons), sans nom : $($stats.unnamedButtons.Count)"
$stats.unnamedButtons | Select-Object -First 10
"document annoncé : $($stats.document)"
"texte exposé : $($stats.textChars) caractères"
"onglets : $($stats.tabs -join ' | ')"
"barres d'outils : $($stats.toolbars -join ' | ')"
"champs de saisie : $($stats.edits)"
