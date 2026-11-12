package com.acme.shop.repository;

import java.math.BigDecimal;

public record OrderTotals(String email, BigDecimal total) {
}
