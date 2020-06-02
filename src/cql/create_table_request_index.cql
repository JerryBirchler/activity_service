CREATE TABLE request_index (
    key_name text,
    key_value text,
    created timestamp,
    "uuid" uuid,
    PRIMARY KEY (key_name, key_value, created, "uuid")
) WITH
  CLUSTERING ORDER BY (key_value ASC,created DESC,"uuid" ASC)
  AND comment=''
  AND read_repair_chance=0
  AND dclocal_read_repair_chance=0.1
  AND gc_grace_seconds=864000
  AND bloom_filter_fp_chance=0.01
  AND compaction={ 'class':'org.apache.cassandra.db.compaction.SizeTieredCompactionStrategy',
  'max_threshold':'32',
  'min_threshold':'4' }
  AND compression={ 'chunk_length_in_kb':'64',
  'class':'org.apache.cassandra.io.compress.LZ4Compressor' }
  AND caching={ 'keys':'ALL',
  'rows_per_partition':'NONE' }
  AND default_time_to_live=0
  AND id='afde9e80-9ab2-11ea-8978-51b56621147b'
  AND min_index_interval=128
  AND max_index_interval=2048
  AND memtable_flush_period_in_ms=0
  AND speculative_retry='99PERCENTILE';
