CREATE TABLE "mutations" (
	"server_seq" bigserial PRIMARY KEY NOT NULL,
	"op_id" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"kind" text NOT NULL,
	"patch" jsonb NOT NULL,
	"timestamp" bigint NOT NULL,
	CONSTRAINT "mutations_op_id_unique" UNIQUE("op_id")
);
