# **Payment service runbook**

Owner: Alice.

## **Failover**

> 1. Drain traffic from the primary.  
> 2. Promote the replica.  
> 3. Switch DNS to the secondary region.