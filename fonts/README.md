# Brand fonts

Drop the `.ttf` / `.otf` files of the typefaces you use in `overlay_text` here, for example:

- `Manrope-Bold.ttf`, `Manrope-ExtraBold.ttf`, … or the variable font `Manrope-VariableFont_wght.ttf`
- `Inter-Regular.ttf`, `Inter-SemiBold.ttf`, … (`Inter_24pt-Bold.ttf` or `Inter-VariableFont_opsz,wght.ttf` also work)

`overlay_text` matches `fontFamily` + `fontWeight` against the file names here, in `~/Library/Fonts`, and in
`/Library/Fonts`, preferring the static file for the exact weight and falling back to the family's variable
font. If nothing matches, it rescans the folders once (so fonts added while the server is running are
picked up without a restart) and then returns an error — it never substitutes a different typeface.

Font files are git-ignored; check each font's license before redistributing it.
