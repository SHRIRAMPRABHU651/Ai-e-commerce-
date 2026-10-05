output "url" { value = "https://${var.domain_name}" }
output "cluster" { value = aws_ecs_cluster.main.name }
output "media_bucket" { value = aws_s3_bucket.media.bucket }
output "alerts_topic" { value = aws_sns_topic.alerts.arn }
