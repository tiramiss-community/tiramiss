# Drive file reads and common packing (#279)

Implement the five read endpoints in #279 under #188/#114, after merged #278. Match upstream `8e07cf085adf7009583d234a208e30436f020e26`; file storage, delivery, mutation and usage accounting remain separate work.

Approaches: keeping a second packer in the API would duplicate public URL/thumbnail rules; moving the existing pure note projection into Drive gives one shared implementation and preserves existing note callers. Choose the latter as an implementation decision under the user's autonomous authorization.

UseCases own current actor authorization and query selection. TypeORM adapters return plain file facts and preload requested folder ancestors/counts and UserLite materials. The renderer receives all materials and performs no I/O. Public projection removes orientation and rotates dimensions, self projection keeps raw properties and original URL. Preserve the upstream distinction: pack hides userId without withUser, whereas nullable/many packing exposes userId. Existing note packing is the latter.

`show` selects by ID or original/webpublic/thumbnail URL; only owner or moderator may read, returning self/detail/withUser. `find` filters the actor's exact name and folder (default root); hash lookup/existence always filter the actor, including moderators. Admin show requires moderator plus read:admin:drive and returns stored fields; request headers are hidden when the owner is a moderator. Missing rows yield the endpoint-specific NO_SUCH_FILE; DB errors propagate. Input precedence and validation follow the pinned endpoint schemas.

UserLite uses the existing note author material reader without a viewer, matching upstream pack(file.userId) without `me`; remote emoji URLs are preloaded explicitly. Folder details reuse #278's renderer with preloaded ancestor/count maps. Never modify the old backend or managed upstream files.

Validation: failing behavior tests before implementation; pure render/missing/material/error unit tests; pinned upstream source-method comparison (not a full upstream server claim); real authenticated HTTP against dedicated PostgreSQL/Redis; note/files and note-show regressions; build/typecheck, changed-file lint, SPDX and locale safety. Record exact comparison limits and keep historic evidence untouched.
