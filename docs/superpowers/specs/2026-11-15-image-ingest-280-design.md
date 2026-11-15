# #280 画像解析と派生画像生成

固定本家 `8e07cf085adf7009583d234a208e30436f020e26` の FileInfoService（推論を除く画像入力）、ImageProcessingService、DriveService.generateAlts の画像分岐を、純粋な bytes 能力として提供する。保存・API・remote取得・動画フレーム・推論は後続責任である。

`modules/drive/image-ingest.ts` は `inspectImageBytes(bytes, {fileName?})`、`convertImageBytes(bytes, format, width, height)`、`generateImageAlts(bytes, mime, generateWeb)` を公開する。結果は解析値と Buffer、MIME、拡張子であり、Sharp・DB・HTTPを公開しない。解析と生成は別操作にして、呼び出し側が解析後のMIMEを生成へ渡す。

選択肢は既存backend Serviceの再利用、独自codec、同じライブラリによる独立実装。旧backend依存は禁止、独自codecは互換性と保守の負担が増えるため、最後を採用する。固定本家と同版の sharp、sharp-read-bmp、file-type、is-svg、probe-image-size、blurhash を直接宣言する。

寸法・orientation・blurhash・MD5とMIMEを本家同様に計算する。画像寸法検出失敗/上限超過でoctet-streamへ戻し、変換失敗は派生物単位で省略する。webpublicは2048、thumbnailは静止498×422/animated374×317。画像はmetadataを剥がし向きを解決し、透過とanimated thumbnailを保持する。AVIF/PNG/WebPの直接変換は最初のフレームを使う。

固定入力のsource-method probeは本家Gitオブジェクトと内容一致を確認して実メソッドを実codecで動かす。FSは本家メソッドの入力にのみ一時ファイルを使用。生成bytesはformat/dimensions/alpha/pages/metadataを読み戻す。予想値を新実装から生成しない。未使用MIME辞書は移植せず、今回実消費する sharp-convertible-image-with-bmp のみ移す。

依存manifest/lockは既存URL-previewの証跡入力。履歴JSONを保持し、この2入力の有限preimageだけをterminal readerへ追加する。8 inventory行のみ更新し#188はpartialを維持する。
