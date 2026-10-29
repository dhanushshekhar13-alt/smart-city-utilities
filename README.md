# Smart City Utilities & Infrastructure Management System

DBMS Level 3 mini-project (PES University, Aug–Dec 2026) by **Dhanush** and **Gagan**.

A system that runs a simulated city's electricity, water and gas: smart meters report readings, residents get correct slab-based bills, and leaks or outages turn into maintenance tickets automatically.

It is built on **polyglot persistence**:

- **PostgreSQL** is the system of record for residents, properties, meters, tariffs, billing cycles, invoices, payments and tickets.
- **MongoDB** stores the raw smart-meter readings (time-series), anomaly events, ticket notes and notifications.
- A monthly **bridge** turns a meter's MongoDB readings into one `meter_reading` row in PostgreSQL, which the billing procedure uses.
